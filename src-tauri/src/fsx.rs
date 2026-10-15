//! Filesystem reads for the explorer.
//!
//! Named `fsx` rather than `fs` so it never reads as `std::fs` at a glance.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Bytes for files; child count for directories.
    pub size: u64,
    /// Unix millis, or 0 when unavailable.
    pub modified: u64,
    pub hidden: bool,
}

#[derive(Serialize)]
pub struct FileBody {
    pub text: String,
    pub lines: usize,
    pub bytes: u64,
    /// False when the file looks binary; `text` is then empty.
    pub textual: bool,
}

fn millis(t: Option<SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    let dir = PathBuf::from(&path);
    let mut out = Vec::new();

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // a broken symlink is not worth failing the listing
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();

        out.push(Entry {
            hidden: name.starts_with('.'),
            size: if is_dir {
                std::fs::read_dir(entry.path())
                    .map(|it| it.count() as u64)
                    .unwrap_or(0)
            } else {
                meta.len()
            },
            modified: millis(meta.modified().ok()),
            dir: is_dir,
            path: entry.path().to_string_lossy().into_owned(),
            name,
        });
    }

    // Directories first, then case-insensitive by name — the ordering every
    // file manager uses because it matches how people scan a list.
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

const PREVIEW_LIMIT: u64 = 512 * 1024;

#[tauri::command]
pub fn fs_read(path: String) -> Result<FileBody, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let bytes = meta.len();

    if bytes > PREVIEW_LIMIT {
        return Ok(FileBody {
            text: String::new(),
            lines: 0,
            bytes,
            textual: false,
        });
    }

    let raw = std::fs::read(&p).map_err(|e| e.to_string())?;
    // A NUL byte in the first block is the same heuristic `grep` uses.
    let looks_binary = raw.iter().take(8000).any(|b| *b == 0);
    if looks_binary {
        return Ok(FileBody {
            text: String::new(),
            lines: 0,
            bytes,
            textual: false,
        });
    }

    let text = String::from_utf8_lossy(&raw).into_owned();
    Ok(FileBody {
        lines: text.lines().count(),
        text,
        bytes,
        textual: true,
    })
}

#[tauri::command]
pub fn fs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string())
}

/// Which project the suite is looking at.
///
/// `SUITE_PROJECT` wins when set, so the suite can be pointed at a project
/// other than the directory it was launched from. Otherwise this is the
/// working directory — stepping up out of `src-tauri`, which is where
/// `tauri dev` starts the binary.
#[tauri::command]
pub fn fs_cwd() -> String {
    if let Ok(project) = std::env::var("SUITE_PROJECT") {
        if PathBuf::from(&project).is_dir() {
            return project;
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.file_name().map(|n| n == "src-tauri").unwrap_or(false) {
        if let Some(parent) = cwd.parent() {
            return parent.to_string_lossy().into_owned();
        }
    }
    cwd.to_string_lossy().into_owned()
}
