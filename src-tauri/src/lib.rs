//! Boot path: display server → fullscreen surface → module registry → home.
//!
//! The Rust side owns everything that touches the OS: PTYs, git, the
//! filesystem, and agent subprocesses. The webview owns pixels and nothing
//! else.

mod agents;
mod fsx;
mod git;
mod probe;
mod pty;

#[cfg(test)]
mod git_tests;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(pty::PtyManager::default()) as pty::SharedPty)
        .manage(Arc::new(agents::AgentManager::default()) as agents::SharedAgents)
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            git::git_root,
            git::git_status,
            git::git_branches,
            git::git_log,
            git::git_diff,
            git::git_diff_untracked,
            git::git_apply_patch,
            git::git_stage_file,
            git::git_commit,
            fsx::fs_list,
            fsx::fs_read,
            fsx::fs_home,
            fsx::fs_cwd,
            agents::agent_spawn,
            agents::agent_kill,
            agents::agent_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
