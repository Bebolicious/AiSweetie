//! Integration tests against a real repository created in a temp directory.
//!
//! These exercise the one operation that justified shelling out to `git` in
//! the first place — staging a single hunk — so it is worth testing for real
//! rather than mocking the CLI.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::git::*;

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

    let status = git_status(repo.path()).unwrap();
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

    let status = git_status(repo.path()).unwrap();

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
    let status = git_status(repo.path()).unwrap();
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

    let status = git_status(repo.path()).unwrap();
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

    let diff = git_diff(repo.path(), "f.txt".into(), false).unwrap();
    let hunks: Vec<&str> = diff.match_indices("@@ -").map(|(_, s)| s).collect();
    assert_eq!(hunks.len(), 2, "expected two hunks:\n{diff}");

    // Build a patch carrying only the first hunk — the same shape the
    // frontend's hunkPatch() produces.
    let header_end = diff.find("@@ -").unwrap();
    let preamble = &diff[..header_end];
    let second = diff[header_end + 4..].find("@@ -").unwrap() + header_end + 4;
    let first_hunk = &diff[header_end..second];
    let patch = format!("{preamble}{first_hunk}");

    git_apply_patch(repo.path(), patch, false).unwrap();

    let status = git_status(repo.path()).unwrap();
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
    let diff = git_diff(repo.path(), "f.txt".into(), false).unwrap();

    git_apply_patch(repo.path(), diff.clone(), false).unwrap();
    assert_eq!(git_status(repo.path()).unwrap().staged.len(), 1);

    // The staged diff is what must be reversed, not the worktree one.
    let staged = git_diff(repo.path(), "f.txt".into(), true).unwrap();
    git_apply_patch(repo.path(), staged, true).unwrap();
    assert!(git_status(repo.path()).unwrap().staged.is_empty());
}

#[test]
fn a_malformed_patch_is_rejected_rather_than_half_applied() {
    let repo = TempRepo::new("bad-patch");
    repo.write("f.txt", &numbered(1..=10));
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.write("f.txt", &numbered(1..=11));

    let err = git_apply_patch(repo.path(), "not a patch at all\n".into(), false)
        .expect_err("git apply should refuse this");
    assert!(!err.is_empty(), "the failure reason should reach the caller");
    assert!(git_status(repo.path()).unwrap().staged.is_empty());
}

#[test]
fn lists_branches_with_the_current_one_marked() {
    let repo = TempRepo::new("branches");
    repo.write("a.txt", "one\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "first"]);
    repo.git(&["branch", "feat/edges"]);

    let branches = git_branches(repo.path()).unwrap();
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

    let log = git_log(repo.path(), 10).unwrap();
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

    let result = git_root(dir.to_string_lossy().into_owned());

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

    let found = git_root(
        repo.dir
            .join("deep/nested")
            .to_string_lossy()
            .into_owned(),
    )
    .unwrap();

    assert_eq!(
        Path::new(&found).canonicalize().unwrap(),
        repo.dir.canonicalize().unwrap()
    );
}
