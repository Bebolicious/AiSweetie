//! Integration tests against a real repository created in a temp directory.
//!
//! These exercise the one operation that justified shelling out to `git` in
//! the first place — staging a single hunk — so it is worth testing for real
//! rather than mocking the CLI.
//!
//! They target the synchronous functions rather than the `#[tauri::command]`
//! shims that wrap them, which is the whole reason the module is split that
//! way: no async runtime to stand up, and the tests stay fast.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::git;

struct TempRepo {
    dir: PathBuf,
}

impl TempRepo {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("suite-git-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let repo = TempRepo { dir };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@suite.local"]);
        repo.git(&["config", "user.name", "Suite Test"]);
        // Keep line endings stable so hunk offsets match on Windows too.
        repo.git(&["config", "core.autocrlf", "false"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(&self.dir)
            .args(args)
            .output()
            .expect("git should be runnable");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(&self, name: &str, body: &str) {
        std::fs::write(self.dir.join(name), body).unwrap();
    }

    fn path(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn numbered(range: std::ops::RangeInclusive<u32>) -> String {
    range
        .map(|i| format!("line {i}\n"))
        .collect::<String>()
}

#[test]
fn reports_branch_and_a_clean_tree() {
    let repo = TempRepo::new("clean");
    repo.write("a.txt", "hello\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    let status = git::status(&repo.path()).unwrap();
    assert_eq!(status.branch, "main");
    assert!(status.staged.is_empty());
    assert!(status.unstaged.is_empty());
}

#[test]
fn separates_staged_from_unstaged_with_line_counts() {
    let repo = TempRepo::new("counts");
    repo.write("a.txt", "one\ntwo\n");
    repo.write("b.txt", "keep\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    repo.write("a.txt", "one\ntwo\nthree\n"); // +1, staged
    repo.git(&["add", "a.txt"]);
    repo.write("b.txt", "keep\nextra\n"); // +1, unstaged

    let status = git::status(&repo.path()).unwrap();

    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "a.txt");
    assert_eq!(status.staged[0].status, "M");
    assert_eq!(status.staged[0].added, 1);
    assert_eq!(status.staged[0].removed, 0);

    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "b.txt");
    assert_eq!(status.unstaged[0].added, 1);
}

#[test]
fn a_file_can_be_staged_and_unstaged_at_once() {
    let repo = TempRepo::new("both");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\n");

    // The same path appears on both sides — the changes column must not
    // collapse them into one row.
    let status = git::status(&repo.path()).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.staged[0].path, status.unstaged[0].path);
}

#[test]
fn untracked_files_are_reported_as_unstaged() {
    let repo = TempRepo::new("untracked");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.write("new.txt", "fresh\n");

    let status = git::status(&repo.path()).unwrap();
    let entry = status
        .unstaged
        .iter()
        .find(|f| f.path == "new.txt")
        .expect("untracked file should show up");
    assert_eq!(entry.status, "?");
}

#[test]
fn staging_one_hunk_leaves_the_other_alone() {
    let repo = TempRepo::new("hunk");
    // Two edits far enough apart that git produces two separate hunks.
    repo.write("f.txt", &numbered(1..=40));
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    let mut lines: Vec<String> = numbered(1..=40).lines().map(String::from).collect();
    lines[2] = "line 3 CHANGED".into();
    lines[36] = "line 37 CHANGED".into();
    repo.write("f.txt", &format!("{}\n", lines.join("\n")));

    let diff = git::diff(&repo.path(), "f.txt",false).unwrap();
    let hunks: Vec<&str> = diff.match_indices("@@ -").map(|(_, s)| s).collect();
    assert_eq!(hunks.len(), 2, "expected two hunks:\n{diff}");

    // Build a patch carrying only the first hunk — the same shape the
    // frontend's hunkPatch() produces.
    let header_end = diff.find("@@ -").unwrap();
    let preamble = &diff[..header_end];
    let second = diff[header_end + 4..].find("@@ -").unwrap() + header_end + 4;
    let first_hunk = &diff[header_end..second];
    let patch = format!("{preamble}{first_hunk}");

    git::apply_patch(&repo.path(), &patch, false).unwrap();

    let status = git::status(&repo.path()).unwrap();
    assert_eq!(status.staged.len(), 1, "first hunk should be staged");
    assert_eq!(status.staged[0].added, 1);
    assert_eq!(status.staged[0].removed, 1);
    assert_eq!(
        status.unstaged.len(),
        1,
        "the second hunk should still be unstaged"
    );
    assert_eq!(status.unstaged[0].added, 1);
}

#[test]
fn applying_a_patch_in_reverse_unstages_it() {
    let repo = TempRepo::new("reverse");
    repo.write("f.txt", &numbered(1..=10));
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    repo.write("f.txt", &numbered(1..=11));
    let diff = git::diff(&repo.path(), "f.txt",false).unwrap();

    git::apply_patch(&repo.path(), &diff, false).unwrap();
    assert_eq!(git::status(&repo.path()).unwrap().staged.len(), 1);

    // The staged diff is what must be reversed, not the worktree one.
    let staged = git::diff(&repo.path(), "f.txt", true).unwrap();
    git::apply_patch(&repo.path(), &staged, true).unwrap();
    assert!(git::status(&repo.path()).unwrap().staged.is_empty());
}

#[test]
fn a_malformed_patch_is_rejected_rather_than_half_applied() {
    let repo = TempRepo::new("bad-patch");
    repo.write("f.txt", &numbered(1..=10));
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.write("f.txt", &numbered(1..=11));

    let err = git::apply_patch(&repo.path(), "not a patch at all\n", false)
        .expect_err("git apply should refuse this");
    assert!(!err.is_empty(), "the failure reason should reach the caller");
    assert!(git::status(&repo.path()).unwrap().staged.is_empty());
}

#[test]
fn a_rename_reports_the_new_path_and_nothing_else() {
    let repo = TempRepo::new("rename");
    repo.write("old name.txt", "a\nb\nc\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    // A space and a non-ASCII byte: both are C-quoted by plain --porcelain,
    // and a rename is printed as `R  "old" -> "new"` on one line.
    repo.git(&["mv", "old name.txt", "nëw name.txt"]);

    let status = git::status(&repo.path()).unwrap();

    assert_eq!(
        status.staged.len(),
        1,
        "the source path must not arrive as a second row: {:?}",
        status.staged.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
    assert_eq!(status.staged[0].status, "R");
    assert_eq!(
        status.staged[0].path, "nëw name.txt",
        "the path must be the renamed file, unquoted and without the arrow"
    );
    assert!(
        status.unstaged.is_empty(),
        "a committed-index rename leaves a clean worktree"
    );

    // The real proof: the path is usable. A path carrying the arrow or the
    // quotes would fail here, which is how this bug reached the UI.
    git::diff(&repo.path(), &status.staged[0].path, true)
        .expect("the reported path must be one git accepts");
}

#[test]
fn a_renamed_and_edited_file_keeps_its_line_counts() {
    let repo = TempRepo::new("rename-edit");
    repo.write("before.txt", "a\nb\nc\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    repo.git(&["mv", "before.txt", "after.txt"]);
    repo.write("after.txt", "a\nb\nc\nd\n");
    repo.git(&["add", "after.txt"]);

    // numstat keys renames by a path the default format mangles, so the +1
    // only lands if both sides agree on what the file is called.
    let status = git::status(&repo.path()).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "after.txt");
    assert_eq!(status.staged[0].added, 1);
    assert_eq!(status.staged[0].removed, 0);
}

/// Run git in an arbitrary directory, for the few tests that need two repos.
fn git_in(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("git should be runnable");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn reports_ahead_and_behind_the_right_way_round() {
    // Previously these came from `rev-list --left-right --count`, whose pair
    // arrives as (behind, ahead) and had to be swapped by hand. Now it is
    // `# branch.ab +N -M`, which is explicit — but a transposition here would
    // be invisible in the UI, so it is worth a test either way.
    let base = std::env::temp_dir().join("suite-git-test-tracking");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    let origin = base.join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git_in(&origin, &["init", "-q", "-b", "main"]);
    git_in(&origin, &["config", "user.email", "t@suite.local"]);
    git_in(&origin, &["config", "user.name", "T"]);
    std::fs::write(origin.join("a.txt"), "one\n").unwrap();
    git_in(&origin, &["add", "."]);
    git_in(&origin, &["commit", "-qm", "first"]);

    git_in(&base, &["clone", "-q", "origin", "work"]);
    let work = base.join("work");
    git_in(&work, &["config", "user.email", "t@suite.local"]);
    git_in(&work, &["config", "user.name", "T"]);

    // Two commits here, none upstream.
    for n in ["two", "three"] {
        std::fs::write(work.join("a.txt"), format!("{n}\n")).unwrap();
        git_in(&work, &["commit", "-qam", n]);
    }

    let s = git::status(&work.to_string_lossy()).unwrap();
    assert_eq!((s.ahead, s.behind), (2, 0), "two local commits is ahead");

    // Now move the upstream on and make it visible.
    std::fs::write(origin.join("b.txt"), "x\n").unwrap();
    git_in(&origin, &["add", "."]);
    git_in(&origin, &["commit", "-qm", "upstream"]);
    git_in(&work, &["fetch", "-q"]);

    let s = git::status(&work.to_string_lossy()).unwrap();
    assert_eq!(
        (s.ahead, s.behind),
        (2, 1),
        "still 2 ahead, now also 1 behind — not transposed"
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_detached_head_is_reported_rather_than_looking_broken() {
    // `branch.ab` is absent entirely when there is no upstream, and
    // `branch.head` reads `(detached)` — neither is an error, and the counts
    // must stay zero rather than parsing garbage.
    let repo = TempRepo::new("detached");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.write("a.txt", "two\n");
    repo.git(&["commit", "-qam", "second"]);
    repo.git(&["checkout", "-q", "HEAD~1"]);

    let s = git::status(&repo.path()).unwrap();
    assert_eq!(s.branch, "(detached)");
    assert_eq!((s.ahead, s.behind), (0, 0));
}

#[test]
fn lists_branches_with_the_current_one_marked() {
    let repo = TempRepo::new("branches");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.git(&["branch", "feat/edges"]);

    let branches = git::branches(&repo.path()).unwrap();
    let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"main"));
    assert!(names.contains(&"feat/edges"));
    assert_eq!(
        branches.iter().filter(|b| b.current).count(),
        1,
        "exactly one branch is HEAD"
    );
    assert!(branches.iter().find(|b| b.current).unwrap().name == "main");
}

#[test]
fn returns_commits_newest_first() {
    let repo = TempRepo::new("log");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "oldest"]);
    repo.write("a.txt", "two\n");
    repo.git(&["commit", "-qam", "newest"]);

    let log = git::log(&repo.path(), 10).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].subject, "newest");
    assert_eq!(log[1].subject, "oldest");
    assert!(!log[0].hash.is_empty());
}

#[test]
fn a_directory_outside_any_repository_reports_an_error() {
    let dir = std::env::temp_dir().join("suite-git-test-not-a-repo");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let result = git::root(&dir.to_string_lossy());

    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        result.is_err(),
        "the UI relies on this failing to show its empty state"
    );
}

#[test]
fn git_root_finds_the_top_from_a_subdirectory() {
    let repo = TempRepo::new("root");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    std::fs::create_dir_all(repo.dir.join("deep/nested")).unwrap();

    let found = git::root(&repo.dir.join("deep/nested").to_string_lossy()).unwrap();

    assert_eq!(
        Path::new(&found).canonicalize().unwrap(),
        repo.dir.canonicalize().unwrap()
    );
}

#[test]
fn the_refs_fingerprint_moves_only_when_a_ref_does() {
    let repo = TempRepo::new("fingerprint");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);

    let fp = || git::refs_fingerprint(&repo.dir).expect("a plain .git dir");
    let base = fp();

    // Editing the worktree and staging it move no ref, which is exactly why
    // `git_status` cannot be cached against this and branches/log can.
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    assert_eq!(fp(), base, "staging must not look like a ref change");

    // Committing moves the branch.
    repo.git(&["commit", "-qm", "second"]);
    let after_commit = fp();
    assert_ne!(after_commit, base, "a commit moves refs/heads/main");

    // So does creating a branch, even though HEAD stays put.
    repo.git(&["branch", "feat/edges"]);
    let after_branch = fp();
    assert_ne!(after_branch, after_commit, "a new branch is a new ref");

    // And so does checking one out, which only rewrites HEAD.
    repo.git(&["checkout", "-q", "feat/edges"]);
    assert_ne!(fp(), after_branch, "HEAD is part of the fingerprint");

    // Nested branch names live in subdirectories; the walk must find them.
    assert!(
        fp().contains("edges"),
        "a branch called feat/edges must be visible to the walk"
    );
}

#[test]
fn a_repo_without_a_plain_git_directory_is_not_cached() {
    // `.git` as a file means a linked worktree or a submodule, where HEAD and
    // the refs can live in different places. Declining to fingerprint is what
    // makes `cached` fall through to always recomputing.
    let dir = std::env::temp_dir().join("suite-git-test-gitfile");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".git"), "gitdir: /elsewhere\n").unwrap();

    assert!(git::refs_fingerprint(&dir).is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
