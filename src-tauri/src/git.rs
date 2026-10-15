//! Git, by way of the `git` CLI.
//!
//! Deliberately not libgit2/gix. The one operation this module exists for —
//! staging an individual hunk — is something libgit2 handles badly, and the
//! honest implementation is "generate a patch and feed it to `git apply`".
//! Once that is true, shelling out for reads too keeps one mental model and
//! one source of truth about what the repository actually says.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct FileChange {
    pub path: String,
    /// Porcelain status letter: M, A, D, R, ? …
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Serialize, Clone)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub age: String,
    pub refs: String,
}

#[derive(Serialize, Clone)]
pub struct RepoStatus {
    pub root: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
}

fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git not runnable: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Walk up from `start` to the repository root, or report that there isn't one.
#[tauri::command]
pub fn git_root(start: String) -> Result<String, String> {
    let path = PathBuf::from(&start);
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().map(Path::to_path_buf).ok_or("bad path")?
    };
    let root = run(&dir, &["rev-parse", "--show-toplevel"])?;
    Ok(root.trim().to_string())
}

/// numstat gives +/- per file; porcelain gives the status letter. Neither
/// alone is enough for the changes column, so they are merged by path.
fn numstat(repo: &Path, cached: bool) -> Vec<(String, u32, u32)> {
    let mut args = vec!["diff", "--numstat"];
    if cached {
        args.push("--cached");
    }
    run(repo, &args)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let added = parts.next()?.parse().unwrap_or(0);
            let removed = parts.next()?.parse().unwrap_or(0);
            let path = parts.next()?.to_string();
            Some((path, added, removed))
        })
        .collect()
}

#[tauri::command]
pub fn git_status(repo: String) -> Result<RepoStatus, String> {
    let dir = PathBuf::from(&repo);
    let root = run(&dir, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let root_path = PathBuf::from(&root);

    let branch = run(&root_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    // No upstream is normal, not an error.
    let (ahead, behind) = run(
        &root_path,
        &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    )
    .ok()
    .and_then(|s| {
        let mut it = s.split_whitespace();
        Some((
            it.next()?.parse().ok()?,
            it.next()?.parse().ok()?,
        ))
    })
    .map(|(b, a): (u32, u32)| (a, b))
    .unwrap_or((0, 0));

    let staged_counts = numstat(&root_path, true);
    let unstaged_counts = numstat(&root_path, false);
    let count_for = |list: &[(String, u32, u32)], path: &str| {
        list.iter()
            .find(|(p, _, _)| p == path)
            .map(|(_, a, r)| (*a, *r))
            .unwrap_or((0, 0))
    };

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in run(&root_path, &["status", "--porcelain"])?.lines() {
        if line.len() < 4 {
            continue;
        }
        let index = &line[0..1];
        let worktree = &line[1..2];
        let path = line[3..].trim_matches('"').to_string();

        if index != " " && index != "?" {
            let (a, r) = count_for(&staged_counts, &path);
            staged.push(FileChange {
                path: path.clone(),
                status: index.to_string(),
                added: a,
                removed: r,
            });
        }
        if worktree != " " {
            let (a, r) = count_for(&unstaged_counts, &path);
            unstaged.push(FileChange {
                path,
                status: worktree.to_string(),
                added: a,
                removed: r,
            });
        }
    }

    Ok(RepoStatus {
        root,
        branch,
        ahead,
        behind,
        staged,
        unstaged,
    })
}

#[tauri::command]
pub fn git_branches(repo: String) -> Result<Vec<Branch>, String> {
    let dir = PathBuf::from(&repo);
    let out = run(
        &dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%09%(HEAD)%09%(committerdate:relative)",
            "refs/heads",
        ],
    )?;

    Ok(out
        .lines()
        .filter_map(|line| {
            let mut p = line.split('\t');
            let name = p.next()?.to_string();
            let current = p.next()? == "*";
            let age = p.next().unwrap_or("").to_string();
            Some(Branch {
                name,
                current,
                age,
            })
        })
        .collect())
}

#[tauri::command]
pub fn git_log(repo: String, limit: u32) -> Result<Vec<Commit>, String> {
    let dir = PathBuf::from(&repo);
    let n = format!("-{limit}");
    let out = run(
        &dir,
        &[
            "log",
            &n,
            "--format=%h%x09%s%x09%cr%x09%D",
        ],
    )?;

    Ok(out
        .lines()
        .filter_map(|line| {
            let mut p = line.split('\t');
            Some(Commit {
                hash: p.next()?.to_string(),
                subject: p.next().unwrap_or("").to_string(),
                age: p.next().unwrap_or("").to_string(),
                refs: p.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

/// Raw unified diff for one file. Hunk parsing happens in the frontend, where
/// it is pure string work and can be tested without a repository.
#[tauri::command]
pub fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    let dir = PathBuf::from(&repo);
    let mut args = vec!["diff", "--no-color", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&path);
    run(&dir, &args)
}

/// A file git has never seen has no diff; synthesise one so new files can be
/// staged through the same path as everything else.
#[tauri::command]
pub fn git_diff_untracked(repo: String, path: String) -> Result<String, String> {
    let dir = PathBuf::from(&repo);
    run(
        &dir,
        &["diff", "--no-color", "-U3", "--no-index", "/dev/null", &path],
    )
    .or_else(|e| {
        // --no-index exits 1 when files differ, which is the normal case here.
        if e.is_empty() {
            Err("could not diff untracked file".into())
        } else {
            Ok(e)
        }
    })
}

/// Stage or unstage a single hunk by applying its patch to the index.
#[tauri::command]
pub fn git_apply_patch(repo: String, patch: String, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let dir = PathBuf::from(&repo);
    // No --unidiff-zero: these patches carry 3 lines of context, and the
    // safety checks it disables are exactly what catches a malformed hunk.
    let mut args = vec!["apply", "--cached"];
    if reverse {
        args.push("--reverse");
    }

    let mut child = Command::new("git")
        .current_dir(&dir)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    child
        .stdin
        .as_mut()
        .ok_or("no stdin")?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;

    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn git_stage_file(repo: String, path: String, unstage: bool) -> Result<(), String> {
    let dir = PathBuf::from(&repo);
    if unstage {
        run(&dir, &["restore", "--staged", "--", &path])?;
    } else {
        run(&dir, &["add", "--", &path])?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_commit(repo: String, message: String) -> Result<String, String> {
    let dir = PathBuf::from(&repo);
    run(&dir, &["commit", "-m", &message])
}
