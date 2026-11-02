//! Git, by way of the `git` CLI.
//!
//! Deliberately not libgit2/gix. The one operation this module exists for —
//! staging an individual hunk — is something libgit2 handles badly, and the
//! honest implementation is "generate a patch and feed it to `git apply`".
//! Once that is true, shelling out for reads too keeps one mental model and
//! one source of truth about what the repository actually says.
//!
//! Every command here is a shim over a synchronous `pub(crate)` function: a
//! process spawn blocks, and a blocking call on the main thread stalls the
//! window (see `task`). The split has a second payoff — `git_tests.rs` tests
//! the synchronous functions against a real repository without a runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::task::blocking;

/// The "before" side of a `--no-index` diff against nothing.
#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

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
    collect(start(repo, args)?)
}

/// Launch `git` without waiting for it.
///
/// Split from `collect` so several invocations can be in flight at once — on
/// Windows a `git` spawn costs about 12 ms whatever it is asked to do, so the
/// difference between three sequential spawns and three overlapping ones is
/// most of the latency.
///
/// `--no-optional-locks` is load-bearing once they overlap: `git status`
/// otherwise refreshes and rewrites the index stat cache, which takes
/// `.git/index.lock` and would collide with the two concurrent diffs. It
/// disables exactly that kind of opportunistic write and nothing a read needs
/// — it is what editors polling a repository are expected to use. Safe on the
/// write paths too, since the locks `add`, `commit` and `restore` take are
/// required rather than optional; the staging tests cover that.
fn start(repo: &Path, args: &[&str]) -> Result<std::process::Child, String> {
    use std::process::Stdio;

    Command::new("git")
        .current_dir(repo)
        .arg("--no-optional-locks")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git not runnable: {e}"))
}

fn collect(child: std::process::Child) -> Result<String, String> {
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git failed: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub async fn git_root(start: String) -> Result<String, String> {
    blocking(move || root(&start)).await
}

/// Walk up from `start` to the repository root, or report that there isn't one.
pub(crate) fn root(start: &str) -> Result<String, String> {
    let path = PathBuf::from(start);
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().map(Path::to_path_buf).ok_or("bad path")?
    };
    let root = run(&dir, &["rev-parse", "--show-toplevel"])?;
    Ok(root.trim().to_string())
}

/// numstat gives +/- per file; porcelain gives the status letter. Neither
/// alone is enough for the changes column, so they are merged by path — which
/// is why this is a map rather than the list it used to be. The merge ran once
/// per changed file over every changed file, and a 2000-file change made that
/// four million comparisons for a column of two numbers.
///
/// `-z` for the same reason `status` uses it: without it a renamed path comes
/// back as `old => new` and matches nothing.
fn numstat(raw: &str) -> HashMap<String, (u32, u32)> {
    let mut counts = HashMap::new();
    let mut fields = raw.split('\0');

    while let Some(record) = fields.next() {
        let mut parts = record.split('\t');
        let (Some(added), Some(removed), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue; // the empty field after the final NUL
        };

        // A rename leaves the path field empty and follows the record with two
        // NUL-terminated fields: the old path, then the new one. The new one is
        // what `status` reports, so that is the key to store under.
        let path = if path.is_empty() {
            let _old = fields.next();
            match fields.next() {
                Some(new) => new,
                None => continue,
            }
        } else {
            path
        };

        // A binary file reports "-" for both counts rather than a number.
        counts.insert(
            path.to_string(),
            (added.parse().unwrap_or(0), removed.parse().unwrap_or(0)),
        );
    }

    counts
}

/// What `status --porcelain=v2 --branch` answers in one invocation.
#[derive(Default)]
struct Porcelain {
    branch: String,
    ahead: u32,
    behind: u32,
    /// (path, index status, worktree status). `.` means unmodified.
    entries: Vec<(String, char, char)>,
}

/// Parse `status --porcelain=v2 --branch -z`.
///
/// Version 2 rather than v1 because it folds in three things that used to each
/// cost their own process: the branch name, the ahead/behind counts, and the
/// changed files. It is also less ambiguous — status characters are positional
/// with `.` for unmodified rather than a space, and ahead/behind arrive as
/// `+1 -2` instead of a `rev-list --left-right` pair whose order has to be
/// remembered and swapped.
///
/// Records are NUL-terminated. Within a record, fields are space-separated and
/// the path is last, so it is taken as "the remainder" — a path may contain
/// spaces, and `-z` is what guarantees it contains no NUL and needs no
/// unquoting.
fn parse_porcelain_v2(raw: &str) -> Porcelain {
    let mut out = Porcelain::default();
    let mut records = raw.split('\0');

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut split = record.splitn(2, ' ');
        let (kind, rest) = (split.next().unwrap_or(""), split.next().unwrap_or(""));

        match kind {
            "#" => {
                let mut kv = rest.splitn(2, ' ');
                match (kv.next(), kv.next()) {
                    (Some("branch.head"), Some(name)) => out.branch = name.to_string(),
                    // "+1 -2". Absent entirely when there is no upstream,
                    // which is why no-upstream is a normal state here.
                    (Some("branch.ab"), Some(ab)) => {
                        for part in ab.split_whitespace() {
                            let n = part[1..].parse().unwrap_or(0);
                            match part.as_bytes().first() {
                                Some(b'+') => out.ahead = n,
                                Some(b'-') => out.behind = n,
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }

            // 1: ordinary   <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // 2: rename     …same, plus <X><score>, and the original path
            //               follows as a record of its own
            // u: unmerged   <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            "1" | "2" | "u" => {
                let count = match kind {
                    "1" => 8,
                    "2" => 9,
                    _ => 10,
                };
                let fields: Vec<&str> = rest.splitn(count, ' ').collect();
                if fields.len() < count {
                    continue;
                }
                if kind == "2" {
                    // Consume the source path, or the next loop reads it as a
                    // change of its own.
                    let _source = records.next();
                }
                let mut xy = fields[0].chars();
                let path = fields[count - 1];
                if !path.is_empty() {
                    out.entries.push((
                        path.to_string(),
                        xy.next().unwrap_or('.'),
                        xy.next().unwrap_or('.'),
                    ));
                }
            }

            // Untracked. Worktree-side only, which is where the UI shows it.
            "?" => {
                if !rest.is_empty() {
                    out.entries.push((rest.to_string(), '.', '?'));
                }
            }

            _ => {} // "!" ignored files, and anything a future git adds
        }
    }

    out
}

#[tauri::command]
pub async fn git_status(repo: String) -> Result<RepoStatus, String> {
    blocking(move || status(&repo)).await
}

/// Everything the changes column needs, in three overlapping `git` calls.
///
/// This was six sequential invocations and measured 95–122 ms, mean 101 ms, of
/// which about 70 ms was nothing but process startup — a `git` spawn costs
/// ~12 ms on Windows whatever you ask it to do. Making it `async` stopped that
/// blocking the window but did not make it cheaper. Two changes did, and
/// `measure_git_status` shows both paying off separately:
///
/// ```text
/// 6 calls, sequential   101.0 ms      (before)
/// 3 calls, sequential    57.0 ms      fewer processes
/// 3 calls, overlapped    32.7 ms      and started together
/// one `git rev-parse`    11.9 ms      the floor, per process
/// ```
///
/// At 32.7 ms for three overlapped calls against 11.9 ms for one, the child
/// *work* overlaps almost perfectly and what remains is three serial
/// `CreateProcess` calls in this thread. Three processes is therefore the floor
/// for this feature set: going lower means dropping the ± column or caching,
/// not restructuring the calls again.
///
/// **Four calls became one.** `status --porcelain=v2 --branch` answers the
/// branch name, the ahead/behind counts and the changed files together, where
/// v1 needed `rev-parse --abbrev-ref`, `rev-list --left-right` and
/// `status --porcelain` separately. And `rev-parse --show-toplevel` went
/// entirely: the caller already holds the root — it came from `git_root` — so
/// re-deriving it was a process spent confirming something known.
///
/// **The remaining three overlap.** The two `--numstat` diffs are genuinely
/// distinct (index-vs-HEAD and worktree-vs-index; no single git command yields
/// both separably), so they stay. But all three are started before any is
/// waited on, which turns three serial spawn latencies into roughly one.
///
/// `root` is now the path it was handed rather than a resolved top level.
/// Nothing reads it, and `git_root` is what callers use when they need one.
pub(crate) fn status(repo: &str) -> Result<RepoStatus, String> {
    let dir = PathBuf::from(repo);

    // All three in flight before anything is collected. Order matters only in
    // that the spawns should not wait on each other.
    let porcelain = start(&dir, &["status", "--porcelain=v2", "--branch", "-z"])?;
    let staged_diff = start(&dir, &["diff", "--numstat", "-z", "--cached"]);
    let unstaged_diff = start(&dir, &["diff", "--numstat", "-z"]);

    // The porcelain call is the one whose failure means "not a repository".
    let porcelain = parse_porcelain_v2(&collect(porcelain)?);

    // A missing diff just means no counts to show, which is how it already
    // behaved — the ± column degrades rather than failing the whole listing.
    let counts = |child: Result<std::process::Child, String>| {
        child
            .and_then(collect)
            .map(|raw| numstat(&raw))
            .unwrap_or_default()
    };
    let staged_counts = counts(staged_diff);
    let unstaged_counts = counts(unstaged_diff);

    let count_for = |counts: &HashMap<String, (u32, u32)>, path: &str| {
        counts.get(path).copied().unwrap_or((0, 0))
    };

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for (path, index, worktree) in porcelain.entries {
        if index != '.' {
            let (a, r) = count_for(&staged_counts, &path);
            staged.push(FileChange {
                path: path.clone(),
                status: index.to_string(),
                added: a,
                removed: r,
            });
        }
        if worktree != '.' {
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
        root: repo.to_string(),
        branch: porcelain.branch,
        ahead: porcelain.ahead,
        behind: porcelain.behind,
        staged,
        unstaged,
    })
}

/// A cheap stand-in for "have the refs moved?"
///
/// Branch lists and commit logs are invalidated by exactly one thing — a ref
/// changing — and that is observable from the filesystem for a handful of
/// `stat`s and a few tiny reads, against ~12 ms to spawn `git`. Which is the
/// test any cache here has to pass: staleness must be cheaper to detect than
/// the work it saves. `git_status` fails that test and is not cached;
/// this passes it.
///
/// Loose refs are read rather than stat'd because a ref file is 41 bytes and
/// a branch moving rewrites it to the same length — size would not change, and
/// mtime granularity is a second on some filesystems. `packed-refs` can be
/// large, so that one is stat'd.
///
/// `None` means "cannot tell", and the caller must then not cache at all. That
/// covers a linked worktree or a submodule, where `.git` is a file pointing
/// somewhere else and HEAD and the refs can live in different directories.
pub(crate) fn refs_fingerprint(repo: &Path) -> Option<String> {
    let git = repo.join(".git");
    if !std::fs::metadata(&git).ok()?.is_dir() {
        return None;
    }

    // HEAD is a few bytes and says which branch we are on.
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;

    let mut refs = Vec::new();
    if let Ok(meta) = std::fs::metadata(git.join("packed-refs")) {
        let secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        refs.push(format!("packed:{}:{}", meta.len(), secs));
    }
    collect_refs(&git.join("refs").join("heads"), &mut refs);

    // `read_dir` order is not specified, so the fingerprint must not depend
    // on it.
    refs.sort_unstable();
    Some(format!("{}|{}", head.trim(), refs.join(",")))
}

/// Every loose ref under `dir`, as `path=contents`. Recursive, because a
/// branch called `feat/edges` is a file inside a `feat` directory.
fn collect_refs(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => collect_refs(&path, out),
            Ok(_) => {
                if let Ok(oid) = std::fs::read_to_string(&path) {
                    out.push(format!("{}={}", path.display(), oid.trim()));
                }
            }
            Err(_) => {}
        }
    }
}

/// How many repositories' results to keep. Nobody has eight projects open,
/// and the eviction is a clear rather than an LRU because at that size the
/// difference cannot matter.
const CACHE_REPOS: usize = 8;

type Store<T> = Mutex<HashMap<String, (String, T)>>;

/// Serve `compute` from `store` while the refs fingerprint is unchanged.
///
/// `fresh` skips the lookup but still records the result, so an explicit
/// refresh repopulates rather than leaving the next call to miss.
fn cached<T: Clone>(
    store: &Store<T>,
    key: String,
    fingerprint: Option<String>,
    fresh: bool,
    compute: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    // Without a fingerprint there is no way to know whether a hit is stale,
    // so there is no cache.
    let Some(fingerprint) = fingerprint else {
        return compute();
    };

    if !fresh {
        if let Some((seen, value)) = store.lock().unwrap().get(&key) {
            if *seen == fingerprint {
                return Ok(value.clone());
            }
        }
    }

    let value = compute()?;
    let mut guard = store.lock().unwrap();
    if guard.len() >= CACHE_REPOS && !guard.contains_key(&key) {
        guard.clear();
    }
    guard.insert(key, (fingerprint, value.clone()));
    Ok(value)
}

#[tauri::command]
pub async fn git_branches(repo: String, fresh: Option<bool>) -> Result<Vec<Branch>, String> {
    blocking(move || {
        static STORE: OnceLock<Store<Vec<Branch>>> = OnceLock::new();
        cached(
            STORE.get_or_init(Default::default),
            repo.clone(),
            refs_fingerprint(Path::new(&repo)),
            fresh.unwrap_or(false),
            || branches(&repo),
        )
    })
    .await
}

pub(crate) fn branches(repo: &str) -> Result<Vec<Branch>, String> {
    let dir = PathBuf::from(repo);
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
pub async fn git_log(
    repo: String,
    limit: u32,
    fresh: Option<bool>,
) -> Result<Vec<Commit>, String> {
    blocking(move || {
        static STORE: OnceLock<Store<Vec<Commit>>> = OnceLock::new();
        cached(
            STORE.get_or_init(Default::default),
            // The limit is part of the question, so it is part of the key.
            format!("{repo}\u{0}{limit}"),
            refs_fingerprint(Path::new(&repo)),
            fresh.unwrap_or(false),
            || log(&repo, limit),
        )
    })
    .await
}

pub(crate) fn log(repo: &str, limit: u32) -> Result<Vec<Commit>, String> {
    let dir = PathBuf::from(repo);
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

#[tauri::command]
pub async fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    blocking(move || diff(&repo, &path, staged)).await
}

/// Raw unified diff for one file. Hunk parsing happens in the frontend, where
/// it is pure string work and can be tested without a repository.
pub(crate) fn diff(repo: &str, path: &str, staged: bool) -> Result<String, String> {
    let dir = PathBuf::from(repo);
    let mut args = vec!["diff", "--no-color", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    run(&dir, &args)
}

#[tauri::command]
pub async fn git_diff_untracked(repo: String, path: String) -> Result<String, String> {
    blocking(move || diff_untracked(&repo, &path)).await
}

/// A file git has never seen has no diff; synthesise one so new files can be
/// staged through the same path as everything else.
pub(crate) fn diff_untracked(repo: &str, path: &str) -> Result<String, String> {
    let dir = PathBuf::from(repo);
    run(
        &dir,
        &["diff", "--no-color", "-U3", "--no-index", NULL_DEVICE, path],
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

#[tauri::command]
pub async fn git_apply_patch(repo: String, patch: String, reverse: bool) -> Result<(), String> {
    blocking(move || apply_patch(&repo, &patch, reverse)).await
}

/// Stage or unstage a single hunk by applying its patch to the index.
pub(crate) fn apply_patch(repo: &str, patch: &str, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let dir = PathBuf::from(repo);
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
pub async fn git_stage_file(repo: String, path: String, unstage: bool) -> Result<(), String> {
    blocking(move || stage_file(&repo, &path, unstage)).await
}

pub(crate) fn stage_file(repo: &str, path: &str, unstage: bool) -> Result<(), String> {
    let dir = PathBuf::from(repo);
    if unstage {
        run(&dir, &["restore", "--staged", "--", path])?;
    } else {
        run(&dir, &["add", "--", path])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String) -> Result<String, String> {
    blocking(move || commit(&repo, &message)).await
}

pub(crate) fn commit(repo: &str, message: &str) -> Result<String, String> {
    let dir = PathBuf::from(repo);
    run(&dir, &["commit", "-m", message])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// The same three invocations, collected one at a time.
    ///
    /// Exists to answer whether overlapping them earns the `start`/`collect`
    /// split, or whether all the gain came from needing three processes
    /// instead of six. If this matches `status`, the split is dead weight.
    fn status_sequential(repo: &str) -> Result<(), String> {
        let dir = PathBuf::from(repo);
        let porcelain = parse_porcelain_v2(&run(
            &dir,
            &["status", "--porcelain=v2", "--branch", "-z"],
        )?);
        let staged =
            numstat(&run(&dir, &["diff", "--numstat", "-z", "--cached"]).unwrap_or_default());
        let unstaged = numstat(&run(&dir, &["diff", "--numstat", "-z"]).unwrap_or_default());
        // Touch the results so nothing is optimised away.
        let _ = (porcelain.entries.len(), staged.len(), unstaged.len());
        Ok(())
    }

    fn timed<F: FnMut()>(runs: u32, mut f: F) -> (f64, f64, f64) {
        let mut best = u128::MAX;
        let mut worst = 0u128;
        let mut total = 0u128;
        for _ in 0..runs {
            let t = Instant::now();
            f();
            let us = t.elapsed().as_micros();
            best = best.min(us);
            worst = worst.max(us);
            total += us;
        }
        let ms = |v: u128| v as f64 / 1000.0;
        (ms(best), total as f64 / runs as f64 / 1000.0, ms(worst))
    }

    /// `git_status` was six sequential `git` invocations at ~101 ms. On Windows
    /// a spawn costs ~12 ms whatever it does, so this measures process count
    /// more than anything git computes.
    #[test]
    #[ignore = "measurement, not a check; run with --ignored --nocapture"]
    fn measure_git_status() {
        let repo = "..";
        if root(repo).is_err() {
            println!("  not a git repository, skipped");
            return;
        }
        const RUNS: u32 = 7;

        let (b1, m1, w1) = timed(RUNS, || {
            let _ = status(repo).expect("status");
        });
        let (b2, m2, w2) = timed(RUNS, || {
            status_sequential(repo).expect("sequential");
        });
        let (bs, ms_, _) = timed(RUNS, || {
            let _ = run(std::path::Path::new(repo), &["rev-parse", "--show-toplevel"]);
        });

        println!(
            "\n── git_status ──\n  \
             3 calls, overlapped   best {b1:>6.1}  mean {m1:>6.1}  worst {w1:>6.1} ms\n  \
             3 calls, sequential   best {b2:>6.1}  mean {m2:>6.1}  worst {w2:>6.1} ms\n  \
             one `git rev-parse`   best {bs:>6.1}  mean {ms_:>6.1} ms\n  \
             >>> was 6 calls at mean 101 ms"
        );
    }

    /// `cached` in isolation, with a counter so a hit is observable.
    ///
    /// The real `git_branches` cannot be tested this way — a hit and a miss
    /// return the same data — so the hit/miss logic is tested here and the
    /// thing that drives it, the fingerprint, is tested in `git_tests.rs`.
    #[test]
    fn serves_a_hit_while_the_fingerprint_holds() {
        let store: Store<u32> = Default::default();
        let mut runs = 0;
        let call = |fp: &str, fresh: bool, runs: &mut u32| {
            cached(&store, "repo".into(), Some(fp.into()), fresh, || {
                *runs += 1;
                Ok(*runs)
            })
        };

        assert_eq!(call("fp1", false, &mut runs).unwrap(), 1);
        // Same fingerprint: served from the store, `compute` not run.
        assert_eq!(call("fp1", false, &mut runs).unwrap(), 1);
        assert_eq!(call("fp1", false, &mut runs).unwrap(), 1);
        assert_eq!(runs, 1);

        // A ref moved.
        assert_eq!(call("fp2", false, &mut runs).unwrap(), 2);
        assert_eq!(call("fp2", false, &mut runs).unwrap(), 2);
        assert_eq!(runs, 2);
    }

    #[test]
    fn fresh_bypasses_the_hit_but_still_records() {
        let store: Store<u32> = Default::default();
        let mut runs = 0;
        let call = |fresh: bool, runs: &mut u32| {
            cached(&store, "repo".into(), Some("fp".into()), fresh, || {
                *runs += 1;
                Ok(*runs)
            })
        };

        assert_eq!(call(false, &mut runs).unwrap(), 1);
        // `r` means refresh even though the fingerprint is unchanged.
        assert_eq!(call(true, &mut runs).unwrap(), 2);
        // ...and the refreshed value is what the next ordinary call gets,
        // rather than a miss because `fresh` declined to store.
        assert_eq!(call(false, &mut runs).unwrap(), 2);
        assert_eq!(runs, 2);
    }

    #[test]
    fn without_a_fingerprint_there_is_no_cache() {
        // A linked worktree: staleness is undetectable, so every call computes.
        let store: Store<u32> = Default::default();
        let mut runs = 0;
        for _ in 0..3 {
            cached(&store, "repo".into(), None, false, || {
                runs += 1;
                Ok(runs)
            })
            .unwrap();
        }
        assert_eq!(runs, 3);
        assert!(store.lock().unwrap().is_empty(), "nothing may be stored");
    }

    #[test]
    fn a_failed_compute_is_not_cached() {
        let store: Store<u32> = Default::default();
        let failed: Result<u32, String> =
            cached(&store, "repo".into(), Some("fp".into()), false, || {
                Err("git exploded".into())
            });
        assert!(failed.is_err());
        assert!(
            store.lock().unwrap().is_empty(),
            "an error must not be served to the next caller"
        );
    }

    #[test]
    fn stays_bounded_across_many_repositories() {
        let store: Store<u32> = Default::default();
        for i in 0..40 {
            cached(&store, format!("repo{i}"), Some("fp".into()), false, || Ok(i)).unwrap();
        }
        assert!(store.lock().unwrap().len() <= CACHE_REPOS);
    }
}
