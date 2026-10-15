//! Agent runner.
//!
//! Agents are `claude` CLI subprocesses in headless mode emitting stream-json,
//! one JSON object per line. That choice means no API key handling here — the
//! CLI already owns authentication — and it means the transcript we render is
//! the real event stream rather than scraped terminal output.
//!
//! Spawned agents are restricted to read-only tools by default. An agent
//! queue that can silently edit the disk is not a feature anyone asked for.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::probe;

/// Where the `claude` binary is, resolved once.
///
/// Resolution is cached for the life of the process: the login-shell fallback
/// in `probe` spawns a shell, and the agents module asks this question on every
/// mount. If the user installs Claude Code while the suite is running they
/// restart it — the alternative is paying for a shell spawn on every check.
fn claude_path() -> Option<&'static Path> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let explicit = std::env::var_os("SUITE_CLAUDE_PATH").map(PathBuf::from);
            let mut dirs = probe::user_bin_dirs();
            // The native installer's own location, which is not on PATH for a
            // graphical session unless the user's profile put it there.
            if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
                dirs.push(home.join(".claude/local"));
            }
            probe::resolve("claude", explicit.as_deref(), &dirs)
        })
        .as_deref()
}

#[derive(Clone, Serialize)]
pub struct AgentLine {
    pub id: String,
    /// One raw stream-json line. Parsed in the frontend.
    pub line: String,
}

#[derive(Clone, Serialize)]
pub struct AgentExit {
    pub id: String,
    pub code: i32,
}

#[derive(Default)]
pub struct AgentManager {
    running: Mutex<HashMap<String, Child>>,
}

/// Read-only by default. Widening this is a deliberate act, not a default.
const SAFE_TOOLS: &str = "Read Glob Grep WebFetch";

impl AgentManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        prompt: String,
        cwd: String,
        model: Option<String>,
        allow_writes: bool,
    ) -> Result<(), String> {
        if self.running.lock().unwrap().contains_key(&id) {
            return Err(format!("agent \"{id}\" is already running"));
        }

        let claude = claude_path().ok_or_else(|| {
            "could not find the `claude` CLI. Install Claude Code, or set \
             SUITE_CLAUDE_PATH to its full path."
                .to_string()
        })?;

        let mut cmd = Command::new(claude);
        cmd.current_dir(&cwd)
            .arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose");

        if let Some(m) = model {
            cmd.arg("--model").arg(m);
        }
        if !allow_writes {
            cmd.arg("--allowed-tools").arg(SAFE_TOOLS);
        }

        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start claude: {e}"))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        self.running.lock().unwrap().insert(id.clone(), child);

        // stdout carries the event stream, one JSON object per line.
        {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if app
                        .emit("agent://line", AgentLine { id: id.clone(), line })
                        .is_err()
                    {
                        break;
                    }
                }
                let _ = app.emit("agent://exit", AgentExit { id, code: 0 });
            });
        }

        // stderr is not JSON; surface it as a synthetic error event so a
        // failure to start is visible in the transcript rather than silent.
        {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let escaped = line.replace('\\', "\\\\").replace('"', "\\\"");
                    let _ = app.emit(
                        "agent://line",
                        AgentLine {
                            id: id.clone(),
                            line: format!(r#"{{"type":"stderr","text":"{escaped}"}}"#),
                        },
                    );
                }
            });
        }

        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        if let Some(mut child) = self.running.lock().unwrap().remove(id) {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

pub type SharedAgents = Arc<AgentManager>;

#[tauri::command]
pub fn agent_spawn(
    app: AppHandle,
    state: tauri::State<'_, SharedAgents>,
    id: String,
    prompt: String,
    cwd: String,
    model: Option<String>,
    allow_writes: Option<bool>,
) -> Result<(), String> {
    state.spawn(
        app,
        id,
        prompt,
        cwd,
        model,
        allow_writes.unwrap_or(false),
    )
}

#[tauri::command]
pub fn agent_kill(state: tauri::State<'_, SharedAgents>, id: String) -> Result<(), String> {
    state.kill(&id)
}

/// What the agents module knows about the `claude` CLI.
///
/// Richer than a bool because the three failure modes need different advice:
/// not installed, installed but not runnable, and installed but not
/// authenticated. The module needs to say which one plainly rather than
/// looking broken.
#[derive(Clone, Serialize, Default)]
pub struct ClaudeStatus {
    pub found: bool,
    /// Where it was found, so the user can confirm it is the one they expect.
    pub path: Option<String>,
    pub version: Option<String>,
    /// Set when the binary exists but would not run.
    pub error: Option<String>,
}

/// Whether the `claude` CLI is usable, and if not, what is wrong.
#[tauri::command]
pub fn agent_available() -> ClaudeStatus {
    let Some(path) = claude_path() else {
        return ClaudeStatus::default();
    };

    let display = path.display().to_string();
    match probe::version(path, "--version") {
        Some(version) => ClaudeStatus {
            found: true,
            path: Some(display),
            version: Some(version),
            error: None,
        },
        // Found the file but it would not run: a broken install, a wrong
        // SUITE_CLAUDE_PATH, or a half-finished update.
        None => ClaudeStatus {
            found: false,
            path: Some(display),
            version: None,
            error: Some("found the binary but `claude --version` failed".into()),
        },
    }
}
