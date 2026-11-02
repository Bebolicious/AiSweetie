//! Filesystem reads for the explorer.
//!
//! Named `fsx` rather than `fs` so it never reads as `std::fs` at a glance.
//!
//! A directory walk blocks, so these are shims over synchronous functions run
//! off the main thread — see `task`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::task::blocking;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Bytes. Always 0 for a directory — see `list`.
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
    /// Unix millis when this was read. The caller keeps it and hands it back
    /// as `known` to ask whether what it holds is still current.
    pub modified: u64,
    /// Set when `known` matched, meaning nothing was read and every other
    /// field should be ignored in favour of what the caller already has.
    pub unchanged: bool,
}

fn millis(t: Option<SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    blocking(move || list(&path)).await
}

/// One directory, one `read_dir`.
///
/// `size` is 0 for a directory rather than its child count. The count was only
/// ever the listing's size column, and it cost a full `read_dir` **per
/// subdirectory** to produce. The explorer shows a dash there instead, which is
/// what every file manager does, and for the same reason.
///
/// Measured (`measure_fs_list_scaling`): roughly **50 µs per subdirectory**, so
/// counting crosses a 16 ms frame at about 330 subdirectories and costs 100 ms
/// at 2000 — which a large project's `node_modules` comfortably exceeds. Worth
/// being honest about the small end too: this repo's own `node_modules` has 87
/// subdirectories and took 4.6 ms, down to 0.2 ms now. A 23× saving, but it was
/// never the freeze it was first claimed to be. The cost is linear in
/// subdirectory count and only bites on directories much larger than this one.
pub(crate) fn list(path: &str) -> Result<Vec<Entry>, String> {
    let dir = PathBuf::from(path);
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
            size: if is_dir { 0 } else { meta.len() },
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
pub async fn fs_read(path: String, known: Option<u64>) -> Result<FileBody, String> {
    blocking(move || read_file(&path, known)).await
}

/// Read a file for preview, or confirm the caller's copy is still current.
///
/// `known` is an mtime the caller already holds. When it matches, this returns
/// after the `metadata` call alone — no read, nothing to send back over the
/// IPC, and nothing for the frontend to re-highlight. That is the whole point:
/// the read is comparatively cheap because it happens off the main thread,
/// while highlighting is synchronous JavaScript over the entire file.
///
/// Validating here rather than trusting an mtime remembered from `fs_list` is
/// deliberate. A listing is a snapshot; a file edited in a terminal pane after
/// it was taken would otherwise be served from a cache forever, because
/// nothing re-lists a directory you are already looking at.
pub(crate) fn read_file(path: &str, known: Option<u64>) -> Result<FileBody, String> {
    let p = PathBuf::from(path);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let bytes = meta.len();
    let modified = millis(meta.modified().ok());

    // `0` means the mtime was unavailable, so it can never confirm anything.
    if known == Some(modified) && modified != 0 {
        return Ok(FileBody {
            text: String::new(),
            lines: 0,
            bytes,
            textual: false,
            modified,
            unchanged: true,
        });
    }

    let unreadable = |bytes| FileBody {
        text: String::new(),
        lines: 0,
        bytes,
        textual: false,
        modified,
        unchanged: false,
    };

    if bytes > PREVIEW_LIMIT {
        return Ok(unreadable(bytes));
    }

    let raw = std::fs::read(&p).map_err(|e| e.to_string())?;
    // A NUL byte in the first block is the same heuristic `grep` uses.
    if raw.iter().take(8000).any(|b| *b == 0) {
        return Ok(unreadable(bytes));
    }

    let text = String::from_utf8_lossy(&raw).into_owned();
    Ok(FileBody {
        lines: text.lines().count(),
        text,
        bytes,
        textual: true,
        modified,
        unchanged: false,
    })
}

/// Synchronous on purpose: an environment lookup, no I/O, nothing to block on.
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
pub async fn fs_cwd() -> String {
    // Infallible, so there is no error to flatten: a panic here would be a bug
    // in two `stat` calls, and falling back to "." is what the body does anyway.
    tauri::async_runtime::spawn_blocking(cwd)
        .await
        .unwrap_or_else(|_| ".".to_string())
}

pub(crate) fn cwd() -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// The implementation this replaced: a `read_dir` per subdirectory, purely
    /// to put a child count in the listing's size column.
    fn list_counting_children(path: &str) -> Result<Vec<Entry>, String> {
        let dir = PathBuf::from(path);
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
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
        Ok(out)
    }

    fn best_of<F: FnMut() -> usize>(runs: u32, mut f: F) -> (u128, usize) {
        let mut best = u128::MAX;
        let mut n = 0;
        for _ in 0..runs {
            let t = Instant::now();
            n = f();
            best = best.min(t.elapsed().as_micros());
        }
        (best, n)
    }

    #[test]
    #[ignore = "measurement, not a check; run with --ignored --nocapture"]
    fn measure_fs_list() {
        // Candidates in descending nastiness. node_modules is the one that
        // used to freeze the window.
        for path in ["../node_modules", "../src", ".."] {
            if std::fs::metadata(path).is_err() {
                println!("  {path:<20} (absent, skipped)");
                continue;
            }
            let subdirs = std::fs::read_dir(path)
                .map(|it| {
                    it.filter_map(Result::ok)
                        .filter(|e| e.metadata().map(|m| m.is_dir()).unwrap_or(false))
                        .count()
                })
                .unwrap_or(0);

            // Warm the OS cache for both, so this measures work and not I/O luck.
            let _ = list_counting_children(path);
            let _ = list(path);

            let (old_us, n) = best_of(3, || list_counting_children(path).unwrap().len());
            let (new_us, _) = best_of(3, || list(path).unwrap().len());

            println!(
                "\n── {path} ──\n  {n} entries, {subdirs} of them directories\n  \
                 counting children  {:>9.2} ms\n  current            {:>9.2} ms\n  \
                 >>> speedup         {:>9.1}x",
                old_us as f64 / 1000.0,
                new_us as f64 / 1000.0,
                old_us as f64 / new_us.max(1) as f64
            );
        }
    }

    /// Where does the child-counting cost actually become perceptible?
    ///
    /// The real `node_modules` here has only 87 subdirectories, so it was
    /// never the multi-second freeze it was claimed to be. This finds the
    /// scale at which it would have been, since the cost is linear in
    /// subdirectory count and a big project's `node_modules` has thousands.
    #[test]
    #[ignore = "measurement, not a check; run with --ignored --nocapture"]
    fn measure_fs_list_scaling() {
        let root = std::env::temp_dir().join(format!("suite-scale-{}", std::process::id()));

        for n in [100usize, 500, 2000] {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("mkdir");
            for i in 0..n {
                let sub = root.join(format!("package-{i}"));
                std::fs::create_dir_all(&sub).expect("mkdir sub");
                // A few files each, so counting children has real work to do.
                for f in 0..4 {
                    std::fs::write(sub.join(format!("f{f}.js")), b"x").expect("write");
                }
            }

            let path = root.to_string_lossy().into_owned();
            let _ = list_counting_children(&path);
            let _ = list(&path);

            let (old_us, _) = best_of(3, || list_counting_children(&path).unwrap().len());
            let (new_us, _) = best_of(3, || list(&path).unwrap().len());

            println!(
                "  {n:>5} subdirs   counting {:>8.2} ms   current {:>7.2} ms   {:>6.1}x",
                old_us as f64 / 1000.0,
                new_us as f64 / 1000.0,
                old_us as f64 / new_us.max(1) as f64
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
