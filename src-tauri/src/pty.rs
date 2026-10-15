//! Real PTYs, one per pane.
//!
//! `portable-pty` hides the part that actually differs between platforms:
//! ConPTY on Windows, `forkpty` everywhere else. Everything above this file
//! sees one interface.
//!
//! Output goes to the webview as base64 rather than a `String`. A PTY emits
//! bytes, and a read can land mid-way through a multi-byte UTF-8 sequence —
//! decoding here would corrupt exactly the box-drawing and emoji output that
//! a terminal module exists to render. The frontend feeds the raw bytes to
//! xterm, which already knows how to reassemble them.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One line of PTY output, addressed to the pane that owns it.
#[derive(Clone, Serialize)]
pub struct PtyOutput {
    pub id: String,
    /// base64 of the raw bytes.
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExit {
    pub id: String,
    pub code: u32,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

/// The shell a developer expects when they open a pane.
fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 when present, else Windows PowerShell.
        let exe = which_pwsh().unwrap_or_else(|| "powershell.exe".to_string());
        CommandBuilder::new(exe)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        // A login shell, so the user's aliases and PATH are actually present.
        cmd.arg("-l");
        cmd
    }
}

#[cfg(windows)]
fn which_pwsh() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("pwsh.exe"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

impl PtyManager {
    /// Spawn a shell and start streaming its output to the webview.
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(&id) {
            return Err(format!("pty \"{id}\" already exists"));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = default_shell();
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Drop the slave handle: on Unix, holding it open means the reader
        // never sees EOF when the shell exits.
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
            },
        );

        // One reader thread per pane. Blocking reads are fine here — the
        // thread exists only to move bytes.
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if app
                            .emit(
                                "pty://output",
                                PtyOutput {
                                    id: id.clone(),
                                    data,
                                },
                            )
                            .is_err()
                        {
                            break; // webview is gone
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit("pty://exit", PtyExit { id, code: 0 });
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("no such pty")?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or("no such pty")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }
}

pub type SharedPty = Arc<PtyManager>;

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, SharedPty>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.spawn(app, id, cwd, cols, rows)
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, SharedPty>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, SharedPty>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, SharedPty>, id: String) -> Result<(), String> {
    state.kill(&id)
}
