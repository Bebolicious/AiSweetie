//! `config.toml` — the one place persistent state lives.
//!
//! Config is part of the product: you are expected to open the file, read it,
//! and hand-edit it. That premise drives every decision below.
//!
//! **Every field has a default and every block is optional.** A hand-written
//! config containing nothing but `[performance]` must load, and the absent
//! blocks must come back as defaults rather than failing the read. This is what
//! `#[serde(default)]` on every struct and field buys.
//!
//! **A malformed file is never overwritten.** The rule from architecture §14 is
//! "changes apply live, the file is written on Settings close" — but applied
//! naively that destroys work: a typo makes the parse fail, the app falls back
//! to defaults, you close Settings, and your hand-edited file is replaced by
//! defaults. So a failed parse is *reported* (`Loaded::error`) and sets
//! `read_only`, which makes `save` refuse. The config you broke is the config
//! you can still fix in an editor.
//!
//! Secrets never land here. The schema holds ids and preferences only.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::task::blocking;

/// Which module sits on which edge.
///
/// Defaults match `edges.ts`, deliberately duplicated rather than shared: the
/// frontend must work with no host at all (`npm run dev`), so it cannot ask
/// Rust for its defaults, and Rust must produce a complete file without asking
/// the frontend. Two copies of four strings is the cheaper of the two costs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Edges {
    pub top: String,
    pub right: String,
    pub bottom: String,
    pub left: String,
}

impl Default for Edges {
    fn default() -> Self {
        Self {
            top: "git".into(),
            right: "terminal".into(),
            bottom: "explorer".into(),
            left: "agents".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Performance {
    pub hardware_accel: bool,
    /// Set false on Linux/WebKitGTK if the swap stutters.
    pub panel_blur: bool,
    pub bounce: bool,
}

impl Default for Performance {
    fn default() -> Self {
        Self {
            hardware_accel: true,
            panel_blur: true,
            bounce: true,
        }
    }
}

/// A project the suite has opened. Order is recency: newest first.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    /// This is the suite's own repository (§12).
    pub self_dev: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Ai {
    pub provider: String,
}

impl Default for Ai {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
        }
    }
}

/// The Managed Agents fleet (§13). Ids only — the keys live in the environment
/// or the OS keychain.
///
/// Reserved ahead of the feature because a Managed Agent is created once and
/// referenced by id forever: losing the id orphans the agent. Cheap to reserve
/// now, a migration to add later.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Fleet {
    /// `agent_…` — the coordinator.
    pub coordinator_agent: String,
    /// `env_…` — the self-hosted sandbox.
    pub environment: String,
    /// `agent_…` roster the coordinator may delegate to. Max 20 per the API.
    pub workers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Modules {
    /// Extra module bundle directories.
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub edges: Edges,
    pub performance: Performance,
    /// Overrides only; unlisted bindings keep their default. `BTreeMap` rather
    /// than `HashMap` so a rewritten file does not reorder the user's hotkeys
    /// into a different arbitrary order on every save.
    pub hotkeys: BTreeMap<String, String>,
    pub projects: Vec<ProjectEntry>,
    pub ai: Ai,
    pub fleet: Fleet,
    pub modules: Modules,
}

/// Where `config.toml` lives.
///
/// `SUITE_CONFIG` overrides it outright, which is what makes this testable
/// without touching the developer's real config — and is a usable escape hatch
/// for running two configurations side by side.
///
/// Otherwise, measured rather than assumed (`show_config_path` below prints
/// it):
///
/// | Platform | Path |
/// |---|---|
/// | Linux | `$XDG_CONFIG_HOME/suite/config.toml`, i.e. `~/.config/suite/config.toml` |
/// | Windows | `%APPDATA%\suite\config\config.toml` |
/// | macOS | `~/Library/Application Support/suite/config.toml` |
///
/// The empty qualifier and organization are deliberate. `from("com",
/// "aisweete", "suite")` is the conventional call, but on Windows it yields
/// `%APPDATA%\aisweete\suite\config\config.toml` — four levels deep with
/// "config" in it twice, for a file whose entire premise is that a human opens
/// it. Empty strings collapse that to `%APPDATA%\suite\config\` and leave the
/// Linux path exactly as the original brief specifies.
pub fn config_path() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("SUITE_CONFIG") {
        return Some(PathBuf::from(explicit));
    }
    directories::ProjectDirs::from("", "", "suite")
        .map(|dirs| dirs.config_dir().join("config.toml"))
}

/// A config read, including whether it can be written back.
#[derive(Serialize, Clone, Debug)]
pub struct Loaded {
    pub config: Config,
    /// Where it was read from, for Settings to display. Empty when no config
    /// directory could be resolved at all.
    pub path: String,
    /// True when the file does not exist yet — a first run, not a problem.
    pub missing: bool,
    /// Why the file could not be used, if it could not. The config above is
    /// defaults in that case.
    pub error: Option<String>,
    /// Refuse to save. Set when the file exists but could not be parsed, so a
    /// typo cannot cost the user their hand-written config.
    pub read_only: bool,
}

#[tauri::command]
pub async fn config_load() -> Loaded {
    tauri::async_runtime::spawn_blocking(load)
        .await
        .unwrap_or_else(|e| Loaded {
            config: Config::default(),
            path: String::new(),
            missing: false,
            error: Some(format!("could not read the config: {e}")),
            read_only: true,
        })
}

pub(crate) fn load() -> Loaded {
    let Some(path) = config_path() else {
        return Loaded {
            config: Config::default(),
            path: String::new(),
            missing: false,
            error: Some("no config directory on this platform".into()),
            read_only: true,
        };
    };
    load_from(&path)
}

/// `load`, against an explicit path.
///
/// The path is a parameter rather than resolved inside, so that neither this
/// nor `save_to` reads process-global state. That is what lets the tests below
/// run in parallel: an earlier version resolved `SUITE_CONFIG` internally, and
/// six tests setting one env var raced and failed about half the time. A test
/// suite that only passes under `--test-threads=1` is a trap.
pub(crate) fn load_from(path: &std::path::Path) -> Loaded {
    let display = path.display().to_string();

    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // A first run. Defaults, and saving is fine — there is nothing to
            // lose by writing the file for the first time.
            return Loaded {
                config: Config::default(),
                path: display,
                missing: true,
                error: None,
                read_only: false,
            };
        }
        Err(e) => {
            let error = Some(format!("could not read {display}: {e}"));
            return Loaded {
                config: Config::default(),
                path: display,
                missing: false,
                error,
                read_only: true,
            };
        }
    };

    match toml::from_str::<Config>(&raw) {
        Ok(config) => Loaded {
            config,
            path: display,
            missing: false,
            error: None,
            read_only: false,
        },
        // The file is there and is not valid. Do not touch it.
        Err(e) => {
            let error = Some(format!("{display} is not valid TOML: {e}"));
            Loaded {
                config: Config::default(),
                path: display,
                missing: false,
                error,
                read_only: true,
            }
        }
    }
}

#[tauri::command]
pub async fn config_save(config: Config) -> Result<String, String> {
    blocking(move || save(&config)).await
}

/// Write the config, creating its directory if needed.
///
/// Written to a sibling temp file and renamed, so an interrupted write cannot
/// leave a half-truncated config behind — the file either is the old one or is
/// the new one. The app reads this at boot; a truncated config is a broken
/// launch.
pub(crate) fn save(config: &Config) -> Result<String, String> {
    let path = config_path().ok_or("no config directory on this platform")?;
    save_to(&path, config)
}

/// `save`, against an explicit path. See `load_from` for why the path is a
/// parameter.
pub(crate) fn save_to(path: &std::path::Path, config: &Config) -> Result<String, String> {
    // Re-read first: if what is on disk cannot be parsed, it is hand-edited
    // work in progress, and overwriting it with our in-memory state is the one
    // unrecoverable thing this function could do.
    let current = load_from(path);
    if current.read_only {
        return Err(current
            .error
            .unwrap_or_else(|| "refusing to overwrite an unreadable config".into()));
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }

    let body = toml::to_string_pretty(config).map_err(|e| format!("could not serialise: {e}"))?;

    let temp = path.with_extension("toml.new");
    std::fs::write(&temp, body).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not replace {}: {e}", path.display())
    })?;

    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch config path unique to this test.
    ///
    /// No `SUITE_CONFIG`, and therefore no shared mutable state — these tests
    /// run in parallel like every other test in the crate.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("suite-config-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join("config.toml")
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_absent_config_loads_defaults_and_is_writable() {
        let path = scratch("absent");

        let loaded = load_from(&path);
        assert!(loaded.missing, "a first run reports the file as missing");
        assert!(loaded.error.is_none(), "a first run is not an error");
        assert!(!loaded.read_only, "a first run must be able to write");
        assert_eq!(loaded.config, Config::default());

        cleanup(&path);
    }

    #[test]
    fn a_partial_config_keeps_defaults_for_what_it_omits() {
        // The hand-editing case: someone sets one toggle and nothing else.
        let path = scratch("partial");
        std::fs::write(&path, "[performance]\npanel_blur = false\n").unwrap();

        let loaded = load_from(&path);
        assert!(loaded.error.is_none(), "{:?}", loaded.error);
        assert!(!loaded.config.performance.panel_blur, "the edit is read");
        assert!(
            loaded.config.performance.bounce,
            "an omitted field keeps its default"
        );
        assert_eq!(
            loaded.config.edges,
            Edges::default(),
            "an omitted block keeps its defaults"
        );

        cleanup(&path);
    }

    /// The property that protects hand-edited work: a typo must not cost the
    /// user their file. The most important test in the module.
    #[test]
    fn a_malformed_config_is_reported_and_never_overwritten() {
        let path = scratch("malformed");
        let broken = "[edges\ntop = \"git\"\n";
        std::fs::write(&path, broken).unwrap();

        let loaded = load_from(&path);
        assert!(loaded.error.is_some(), "the parse failure must be reported");
        assert!(loaded.read_only, "a broken config must not be writable");
        assert_eq!(loaded.config, Config::default(), "fall back to defaults");

        let result = save_to(&path, &Config::default());
        assert!(result.is_err(), "save must refuse");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            broken,
            "the user's file must be byte-for-byte untouched"
        );

        cleanup(&path);
    }

    #[test]
    fn a_saved_config_round_trips() {
        let path = scratch("roundtrip");

        let mut config = Config::default();
        config.edges.top = "terminal".into();
        config.edges.right = "git".into();
        config.performance.bounce = false;
        config.projects.push(ProjectEntry {
            name: "aisweete".into(),
            path: "/home/u/Projects/aisweete".into(),
            self_dev: true,
        });
        config.hotkeys.insert("git.stageHunk".into(), "space".into());
        config.fleet.coordinator_agent = "agent_01abc".into();
        config.fleet.workers.push("agent_01def".into());

        save_to(&path, &config).expect("save");
        let loaded = load_from(&path);

        assert!(loaded.error.is_none(), "{:?}", loaded.error);
        assert_eq!(loaded.config, config, "every field survives the round trip");

        cleanup(&path);
    }

    #[test]
    fn saving_creates_the_config_directory() {
        // First run on a fresh machine: the directory does not exist yet.
        let dir = std::env::temp_dir().join(format!("suite-config-mkdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("config.toml");

        save_to(&path, &Config::default()).expect("save should create the directory");
        assert!(path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `deny_unknown_fields` turns a typo into a visible failure instead of a
    /// setting that mysteriously does nothing. Combined with the
    /// never-overwrite rule, the user keeps their file and gets told why.
    #[test]
    fn an_unknown_key_is_an_error_rather_than_silently_dropped() {
        let path = scratch("typo");
        std::fs::write(&path, "[performance]\npanel_blurr = false\n").unwrap();

        let loaded = load_from(&path);
        assert!(loaded.error.is_some(), "a misspelled key must be reported");
        assert!(loaded.read_only);

        cleanup(&path);
    }

    #[test]
    fn suite_config_overrides_the_platform_path() {
        // The escape hatch itself — checked without touching the real config,
        // and the one test that must serialise, hence no file I/O here.
        let before = std::env::var_os("SUITE_CONFIG");
        std::env::set_var("SUITE_CONFIG", "/tmp/elsewhere/config.toml");
        let resolved = config_path().expect("an explicit override always resolves");
        assert!(resolved.ends_with("config.toml"));
        assert!(resolved.to_string_lossy().contains("elsewhere"));
        match before {
            Some(v) => std::env::set_var("SUITE_CONFIG", v),
            None => std::env::remove_var("SUITE_CONFIG"),
        }
    }
}

#[cfg(test)]
mod where_tests {
    /// Not an assertion — prints the resolved path so the docs can state the
    /// real one per platform instead of guessing.
    /// `cargo test -- --ignored --nocapture show_config_path`
    #[test]
    #[ignore = "diagnostic; run with --ignored --nocapture"]
    fn show_config_path() {
        let before = std::env::var_os("SUITE_CONFIG");
        std::env::remove_var("SUITE_CONFIG");
        println!("\n  resolved config path: {:?}", super::config_path());
        if let Some(v) = before {
            std::env::set_var("SUITE_CONFIG", v);
        }
    }
}
