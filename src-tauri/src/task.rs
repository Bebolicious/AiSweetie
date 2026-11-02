//! Keeping OS work off the thread that draws.
//!
//! A `#[tauri::command]` declared with plain `fn` runs on the **main thread** —
//! the one pumping the window's message loop. Nearly everything this app asks
//! the OS for blocks: `git` subprocesses, directory walks, file reads, waiting
//! for a child to die. Any one of them on the main thread freezes the window,
//! and the 440ms edge swap is the first thing to show it. `git_status` alone is
//! six sequential process spawns.
//!
//! So a command that touches the OS is `async` and does its work here instead,
//! on the async runtime's blocking pool. The command itself becomes a shim:
//! clone what the work needs, hand it over, await. The real logic stays in a
//! plain synchronous function, which is also what lets the tests call it
//! without standing up a runtime.
//!
//! Two commands deliberately stay synchronous — see `pty::pty_write` and
//! `pty::pty_resize`. Neither blocks, and both want the ordering that running
//! on one thread gives them for free.

/// Run blocking work off the main thread.
///
/// The join error can only happen if the closure panicked, which is a bug
/// rather than something a caller can handle. It is flattened into the same
/// `String` error every command already returns, so a panic surfaces in the UI
/// instead of vanishing into a dropped future.
pub async fn blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}
