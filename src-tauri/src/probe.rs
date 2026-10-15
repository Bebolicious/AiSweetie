//! Locating external binaries.
//!
//! `Command::new("claude")` resolves against the PATH *this process* inherited,
//! which is not the PATH the user sees in their terminal. Launched from a
//! terminal the two agree. Launched from a desktop launcher or an autostart
//! entry they do not: a graphical session gets the login environment, which on
//! Debian/Ubuntu usually includes `~/.local/bin` (their `~/.profile` adds it)
//! but never the PATH that nvm, pyenv, or asdf export from `~/.bashrc` —
//! `.bashrc` is only read by interactive shells.
//!
//! The practical consequence: a tool the user installed five minutes ago works
//! when the suite is started with `npm run tauri dev` and is invisible when the
//! same build is started from an icon. That is not a failure worth reporting to
//! the user as "not installed", so resolution looks wider than one PATH lookup.
//!
//! Order is by cost. Only the last step spawns a process, and every answer is
//! cached by the caller for the life of the process.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Candidate file names for a binary. On Windows a "binary" on PATH is usually
/// `claude.cmd` or `claude.exe`, never the bare name.
fn file_names(bin: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        // PATHEXT is the authority on what counts as executable here. Include
        // the bare name too, in case the caller passed one already suffixed.
        let exts = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let mut names = vec![bin.to_string()];
        names.extend(
            exts.split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!("{bin}{}", e.to_lowercase())),
        );
        names
    }
    #[cfg(not(windows))]
    {
        vec![bin.to_string()]
    }
}

/// Whether this path is a file we could actually execute.
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Look for `bin` in an explicit list of directories, in order.
pub fn in_dirs<I, P>(bin: &str, dirs: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let names = file_names(bin);
    for dir in dirs {
        for name in &names {
            let candidate = dir.as_ref().join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Look for `bin` on the PATH this process inherited.
pub fn on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    in_dirs(bin, std::env::split_paths(&path))
}

/// Ask the user's login shell where `bin` is.
///
/// This is the step that finds version-manager installs (nvm, asdf, pyenv),
/// because a login shell sources the profile files that set them up. It costs a
/// process spawn and can be slow if the user's profile is heavy, so it runs
/// last and exactly once.
///
/// `command -v` can also name a shell function or alias, which we cannot spawn
/// — hence the absolute-path check on the way out.
#[cfg(not(windows))]
pub fn via_login_shell(bin: &str) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(shell)
        .arg("-lc")
        .arg(format!("command -v {bin}"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = PathBuf::from(found);
    if path.is_absolute() && is_executable(&path) {
        Some(path)
    } else {
        None
    }
}

#[cfg(windows)]
pub fn via_login_shell(_bin: &str) -> Option<PathBuf> {
    // No login-shell concept to consult: PATH in a Windows GUI process already
    // reflects the user and machine environment blocks.
    None
}

/// Full resolution for `bin`.
///
/// `explicit` is a user-configured path and wins outright when it is usable —
/// an override that silently falls back to a different binary is worse than one
/// that fails. `extra` are well-known install locations to try before paying
/// for the login shell.
pub fn resolve(bin: &str, explicit: Option<&Path>, extra: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return is_executable(path).then(|| path.to_path_buf());
    }
    on_path(bin)
        .or_else(|| in_dirs(bin, extra))
        .or_else(|| via_login_shell(bin))
}

/// Run `<path> <arg>` and return its first line of output.
///
/// Used both to report a version and to confirm the thing we found actually
/// runs — a file with the execute bit set is not proof of a working install.
pub fn version<S: AsRef<OsStr>>(path: &Path, arg: S) -> Option<String> {
    let output = Command::new(path)
        .arg(arg)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// Directories worth checking for a tool installed per-user, beyond PATH.
pub fn user_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    if let Some(home) = home {
        dirs.push(home.join(".local/bin")); // native installers, pipx, pip --user
        dirs.push(home.join(".npm-global/bin")); // common npm prefix override
        dirs.push(home.join("bin"));
        #[cfg(windows)]
        {
            dirs.push(home.join("AppData/Roaming/npm")); // npm -g on Windows
        }
    }

    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }

    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch directory. Avoids a tempfile dependency for two tests.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "suite-probe-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        path
    }

    #[test]
    fn finds_an_executable_in_an_explicit_directory() {
        let dir = scratch("in-dirs");
        let name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        let expected = write_executable(&dir, name);

        let found = in_dirs("tool", [&dir]).expect("should find the tool");
        assert_eq!(found, expected);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn earlier_directories_win() {
        let first = scratch("order-first");
        let second = scratch("order-second");
        let name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        let expected = write_executable(&first, name);
        write_executable(&second, name);

        let found = in_dirs("tool", [&first, &second]).expect("should find the tool");
        assert_eq!(found, expected, "PATH order must be respected");

        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(&second);
    }

    #[test]
    fn a_directory_is_not_an_executable() {
        let dir = scratch("not-exe");
        std::fs::create_dir_all(dir.join("tool")).expect("create dir named like a tool");

        assert!(
            in_dirs("tool", [&dir]).is_none(),
            "a directory named `tool` must not resolve as the binary"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_explicit_override_does_not_fall_back() {
        let missing = PathBuf::from("/nonexistent/claude-that-is-not-there");
        assert!(
            resolve("sh", Some(&missing), &[]).is_none(),
            "an explicit override must fail loudly rather than resolve something else"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_a_real_binary_through_the_full_chain() {
        let sh = resolve("sh", None, &user_bin_dirs()).expect("sh must exist on unix");
        assert!(sh.is_absolute(), "resolution must yield an absolute path");
        assert!(is_executable(&sh));
    }

    #[test]
    fn version_reports_output_of_a_working_binary() {
        // Every platform we target ships one of these and both print a line.
        let (bin, arg) = if cfg!(windows) {
            ("cmd", "/c echo probe-ok")
        } else {
            ("sh", "-c echo probe-ok")
        };
        let Some(path) = resolve(bin, None, &[]) else {
            return; // nothing to assert against on an unusual host
        };
        // Split so the argument reaches the child as two argv entries.
        let output = Command::new(&path)
            .args(arg.split_once(' ').map(|(a, b)| [a, b]).unwrap())
            .output()
            .expect("spawn");
        assert!(String::from_utf8_lossy(&output.stdout).contains("probe-ok"));
    }
}
