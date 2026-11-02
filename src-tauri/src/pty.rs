//! Real PTYs, one per pane.
//!
//! `portable-pty` hides the part that actually differs between platforms:
//! ConPTY on Windows, `forkpty` everywhere else. Everything above this file
//! sees one interface.
//!
//! Output never becomes a `String`. A PTY emits bytes, and a read can land
//! mid-way through a multi-byte UTF-8 sequence — decoding here would corrupt
//! exactly the box-drawing and emoji output that a terminal module exists to
//! render. The frontend feeds raw bytes to xterm, which already knows how to
//! reassemble them across chunk boundaries.
//!
//! It travels on a per-pane [`Channel`] rather than a global event, which
//! matters more than it sounds. `app.emit` is a broadcast: every pane's
//! listener received every other pane's output and threw it away in
//! JavaScript, so a 2×2 grid crossed each chunk into the webview four times to
//! use it once. A channel has exactly one subscriber, chosen in Rust.
//!
//! Chunks are also coalesced before being sent, and the reason is specific to
//! how Tauri moves a channel message. Under 1 KB, a raw payload is serialised
//! as a JSON array of numbers and `eval`'d into the webview — about five bytes
//! of JavaScript source per byte of data, which is worse than the base64 this
//! replaced. At or above 1 KB it goes through the fetch path instead and
//! arrives as real binary, no text encoding at all. So batching is not a
//! refinement on top of the channel; it is the thing that makes the channel
//! pay.
//!
//! Measured, by `measure_batch_sizes` in this file's tests: 2 MB of build-log
//! output produced **9602 reads and 33 messages**, every one of them 51–64 KB
//! and so every byte on the binary path. A slow trickle — one short line every
//! 40 ms — does land wholly on the `eval` path as expected, but carries 216
//! bytes in total. The bad case is real and irrelevant.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::task::blocking;

/// How long to keep gathering before flushing a batch to the webview.
///
/// One frame is 16ms, so this is invisible for echo while being long enough
/// that a program producing output steadily fills a batch worth sending.
const COALESCE_WINDOW: Duration = Duration::from_millis(3);

/// Flush early once a batch reaches this size rather than holding the window.
const COALESCE_MAX: usize = 64 * 1024;

#[derive(Clone, Serialize)]
pub struct PtyExit {
    pub id: String,
    pub code: u32,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Keystrokes reach the shell through here, not through a `Write` called
    /// inline. Two reasons, and both are about `pty_write` being called once
    /// per keypress.
    ///
    /// **Order.** A channel preserves it by construction. Had `pty_write`
    /// instead been moved onto the blocking pool like every other command,
    /// nothing would guarantee that two fast keypresses reached the shell in
    /// the order they were typed, and `ls` would occasionally arrive as `sl`.
    ///
    /// **Blocking.** A write to a PTY whose buffer is full blocks the caller
    /// until the program on the other end reads — and the caller is the thread
    /// pumping the window. A channel send never blocks, which is what lets
    /// `pty_write` stay synchronous honestly rather than by oversight.
    input: Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

/// The shell a developer expects when they open a pane.
fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 when present, else Windows PowerShell.
        let exe = which_pwsh().unwrap_or_else(|| "powershell.exe".to_string());
        CommandBuilder::new(exe)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        // A login shell, so the user's aliases and PATH are actually present.
        cmd.arg("-l");
        cmd
    }
}

#[cfg(windows)]
fn which_pwsh() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("pwsh.exe"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Gather PTY reads into batches worth sending, and send them.
///
/// Blocks for the first chunk, then keeps gathering for [`COALESCE_WINDOW`] or
/// until [`COALESCE_MAX`] bytes, whichever comes first. A program emitting
/// steadily therefore produces large binary payloads instead of a flood of
/// tiny ones; an idle shell costs nothing, because the first `recv` blocks
/// rather than polling.
///
/// Ends when the reader drops its sender — flushing what it is holding first,
/// so the tail of a program's output is never lost to the window.
fn batch_output(
    pending: std::sync::mpsc::Receiver<Vec<u8>>,
    output: Channel<InvokeResponseBody>,
) {
    // Nothing to do until something arrives — this `recv` is what makes an
    // idle shell free rather than a thread waking on a timer.
    while let Ok(first) = pending.recv() {
        let mut batch = first;
        batch.reserve(COALESCE_MAX.saturating_sub(batch.len()));

        let deadline = std::time::Instant::now() + COALESCE_WINDOW;
        let mut sender_gone = false;

        while batch.len() < COALESCE_MAX {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match pending.recv_timeout(left) {
                Ok(more) => batch.extend_from_slice(&more),
                Err(RecvTimeoutError::Timeout) => break,
                // The reader hung up. Send what we have, then stop: this is
                // the tail of a program's output and dropping it would lose
                // the last thing it said.
                Err(RecvTimeoutError::Disconnected) => {
                    sender_gone = true;
                    break;
                }
            }
        }

        if output.send(InvokeResponseBody::Raw(batch)).is_err() {
            break; // webview is gone
        }
        if sender_gone {
            break;
        }
    }
}

impl PtyManager {
    /// Spawn a shell and start streaming its output to the webview.
    ///
    /// Takes `Arc<Self>` rather than `&self` so the reader thread can hold a
    /// `Weak` back to the manager and clean its own session up when the shell
    /// exits — see `reap`.
    pub fn spawn(
        self: &Arc<Self>,
        app: AppHandle,
        id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        output: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(&id) {
            return Err(format!("pty \"{id}\" already exists"));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = default_shell();
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Drop the slave handle: on Unix, holding it open means the reader
        // never sees EOF when the shell exits.
        drop(pair.slave);

        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        // Drains input for this pane. Ends when the sender is dropped, which
        // happens when the session leaves the map — so closing a pane cleans
        // this thread up without needing to signal it.
        let (input, rx) = channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for chunk in rx {
                if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                master: pair.master,
                input,
                child,
            },
        );

        // Reads move to the batcher over this channel rather than straight to
        // the webview, so the reader thread never waits on the IPC and a burst
        // of small reads becomes one send.
        let (chunks, pending) = channel::<Vec<u8>>();
        std::thread::spawn(move || batch_output(pending, output));

        // One reader thread per pane. Blocking reads are fine here — the
        // thread exists only to move bytes.
        let manager = Arc::downgrade(self);
        std::thread::spawn(move || {
            // Sized to `COALESCE_MAX` so a single read can fill a whole batch.
            //
            // Measured (`measure_batch_sizes`): this buys almost nothing on
            // its own. Pushing 2 MB through produced 9602 reads averaging ~224
            // bytes each — a read returns what is *available*, not what the
            // buffer could hold, so an 8 KB buffer would have seen the same
            // reads. The coalescing below is what turned those 9602 reads into
            // 33 messages, not this number.
            let mut buf = vec![0u8; COALESCE_MAX];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if chunks.send(buf[..n].to_vec()).is_err() {
                            break; // the batcher is gone, so the webview is too
                        }
                    }
                    Err(_) => break,
                }
            }
            // Let the batcher flush what it is holding and finish.
            drop(chunks);

            // EOF means the shell is gone. Nobody else will notice: the user
            // typed `exit` rather than closing the pane, so no `pty_kill` is
            // coming. Reaping here is what keeps a day of opening and closing
            // shells from accumulating zombies.
            let code = manager
                .upgrade()
                .and_then(|m| m.reap(&id))
                .unwrap_or(0);
            let _ = app.emit("pty://exit", PtyExit { id, code });
        });

        Ok(())
    }

    /// Drop a finished session and collect the shell's exit status.
    ///
    /// Returns `None` when the session is already gone, which is the normal
    /// case for a pane the user closed — `kill` got there first.
    ///
    /// Dropping the `Session` is what ends the writer thread, since that moves
    /// the last `Sender` out of scope.
    fn reap(&self, id: &str) -> Option<u32> {
        // The guard is a temporary, so the lock is released before `wait()`.
        let mut session = self.sessions.lock().unwrap().remove(id)?;
        Some(
            session
                .child
                .wait()
                .map(|status| status.exit_code())
                .unwrap_or(0),
        )
    }

    /// Hand input to the pane's writer thread. Never blocks on the PTY.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or("no such pty")?;
        session
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| "the pty writer has gone away".to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or("no such pty")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        // Take the session out under the lock, then wait outside it. `wait()`
        // blocks until the shell is actually gone, and holding the map lock for
        // that long would stall every other pane's keystrokes behind it.
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(mut session) = session {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }
}

pub type SharedPty = Arc<PtyManager>;

/// Opening a PTY and spawning a shell both block.
///
/// `output` is created by the frontend *before* this is called, so there is no
/// window in which the shell has started and nothing is listening — the race
/// the old event-based path had to work around by subscribing first and
/// awaiting that subscription.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, SharedPty>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let ptys = state.inner().clone();
    blocking(move || ptys.spawn(app, id, cwd, cols, rows, output)).await
}

/// Synchronous on purpose — one of two commands in the app that is.
///
/// This is called once per keypress, so it is the most frequent command there
/// is, and it does no blocking work: the body is a channel send (see
/// `Session::input`). Running it on the main thread also means the main thread
/// orders it, which is the cheapest correct way to guarantee that keystrokes
/// reach the shell in the order they were typed.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, SharedPty>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data)
}

/// Synchronous on purpose: one ioctl, nothing to block on. Keeping it here
/// also keeps resizes ordered against each other, so the last one a
/// `ResizeObserver` burst produces is the one the shell ends up with.
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, SharedPty>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

/// Waits for the shell to die, so it cannot run on the main thread.
#[tauri::command]
pub async fn pty_kill(
    state: tauri::State<'_, SharedPty>,
    id: String,
) -> Result<(), String> {
    let ptys = state.inner().clone();
    blocking(move || ptys.kill(&id)).await
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    struct Recorded {
        bytes: Arc<Mutex<Vec<u8>>>,
        sends: Arc<AtomicUsize>,
    }

    /// A channel that records what the batcher sends instead of reaching a
    /// webview. `Channel::new` takes a plain closure, which is what makes the
    /// output path testable at all without a running app.
    fn recording() -> (Channel<InvokeResponseBody>, Recorded) {
        let bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sends = Arc::new(AtomicUsize::new(0));
        let seen = bytes.clone();
        let counted = sends.clone();

        let sink = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(raw) = body {
                counted.fetch_add(1, Ordering::Relaxed);
                seen.lock().unwrap().extend_from_slice(&raw);
            }
            Ok(())
        });

        (sink, Recorded { bytes, sends })
    }

    /// The invariant a terminal cannot survive losing: every byte the shell
    /// produced reaches the webview, exactly once, in the order it was read.
    /// Coalescing is only acceptable because it is transparent to this.
    #[test]
    fn preserves_every_byte_in_order() {
        let (sink, rec) = recording();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let worker = std::thread::spawn(move || batch_output(rx, sink));

        let expected: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        // Odd chunk size, so batch boundaries fall mid-pattern.
        for chunk in expected.chunks(7) {
            tx.send(chunk.to_vec()).unwrap();
        }
        drop(tx);
        worker.join().unwrap();

        assert_eq!(*rec.bytes.lock().unwrap(), expected);
    }

    #[test]
    fn coalesces_a_burst_into_far_fewer_sends() {
        let (sink, rec) = recording();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let worker = std::thread::spawn(move || batch_output(rx, sink));

        // 400 single-byte reads is what a program printing steadily looks
        // like, and used to be 400 trips across the IPC boundary.
        for _ in 0..400 {
            tx.send(vec![b'x']).unwrap();
        }
        drop(tx);
        worker.join().unwrap();

        assert_eq!(rec.bytes.lock().unwrap().len(), 400);
        // Deliberately tight. `< 400` would pass even if batching barely
        // worked; the point of the window is that a burst collapses to a
        // handful of messages, not merely fewer than it started with.
        let sends = rec.sends.load(Ordering::Relaxed);
        assert!(
            sends <= 5,
            "a 400-read burst should collapse to a few messages, got {sends}"
        );
    }

    /// The last thing a program says is usually the thing you were waiting
    /// for, and it arrives immediately before the reader hits EOF. Dropping it
    /// because the coalescing window had not closed yet would be a bug nobody
    /// could diagnose from the UI.
    #[test]
    fn flushes_the_tail_when_the_reader_hangs_up() {
        let (sink, rec) = recording();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let worker = std::thread::spawn(move || batch_output(rx, sink));

        tx.send(b"done\n".to_vec()).unwrap();
        drop(tx); // EOF at once — no time for the window to elapse
        worker.join().unwrap();

        assert_eq!(&*rec.bytes.lock().unwrap(), b"done\n");
    }

    /// A failed send means the window is gone. The batcher has to end, or
    /// every closed pane leaves a thread parked on a channel forever.
    #[test]
    fn stops_when_the_webview_is_gone() {
        let sink = Channel::new(|_| Err(tauri::Error::WebviewNotFound));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let worker = std::thread::spawn(move || batch_output(rx, sink));

        tx.send(vec![1, 2, 3]).unwrap();
        // The sender stays alive on purpose: only the send failure should end
        // the loop, and `join` would hang if it did not.
        worker.join().expect("the batcher must exit on a failed send");
        drop(tx);
    }

    // ─── measurement ────────────────────────────────────────────────────
    //
    // Not a check. `COALESCE_WINDOW` and `COALESCE_MAX` were chosen from
    // reasoning about frame budgets, and the thing that decides whether they
    // are right is empirical: Tauri sends a raw channel payload under 1 KB as
    // an `eval`'d JSON number array (~5 bytes of JS per byte of data) and only
    // uses the binary fetch path at or above it. So what matters is not how
    // many batches are small, but what fraction of *bytes* ride in small
    // batches. Run it:
    //
    //   cargo test -- --ignored --nocapture measure_batch_sizes

    fn percentile(sorted: &[usize], p: f64) -> usize {
        if sorted.is_empty() {
            return 0;
        }
        let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[i]
    }

    fn report(label: &str, reads: &[usize], batches: &[usize]) {
        let read_bytes: usize = reads.iter().sum();
        let batch_bytes: usize = batches.iter().sum();
        let mut sorted = batches.to_vec();
        sorted.sort_unstable();

        let small: Vec<usize> = batches.iter().copied().filter(|n| *n < 1024).collect();
        let small_bytes: usize = small.iter().sum();
        let pct = |a: usize, b: usize| if b == 0 { 0.0 } else { a as f64 * 100.0 / b as f64 };

        println!("\n── {label} ─────────────────────────────────");
        println!("  bytes through pipe     {read_bytes}");
        println!("  reader reads           {}", reads.len());
        println!("  batches sent           {}", batches.len());
        if !batches.is_empty() {
            println!(
                "  coalescing ratio       {:.1} reads per batch",
                reads.len() as f64 / batches.len() as f64
            );
            println!(
                "  batch size  min {}  p50 {}  p90 {}  max {}",
                sorted[0],
                percentile(&sorted, 0.50),
                percentile(&sorted, 0.90),
                sorted[sorted.len() - 1]
            );
            println!(
                "  under 1 KB             {} of {} batches ({:.1}%)",
                small.len(),
                batches.len(),
                pct(small.len(), batches.len())
            );
            println!(
                "  >>> BYTES on the eval path  {small_bytes} of {batch_bytes} ({:.1}%)",
                pct(small_bytes, batch_bytes)
            );
        }
        assert_eq!(read_bytes, batch_bytes, "the pipeline must not lose bytes");
    }

    /// Drive a real program's output through the production reader loop and
    /// the production `batch_output`.
    ///
    /// Deliberately an ordinary pipe rather than a PTY. Driving a real ConPTY
    /// from a test harness turned out not to terminate — the child outlives
    /// `wait()` and the reader never sees EOF while the master is held — which
    /// makes the harness itself the unknown, and a measurement whose apparatus
    /// is suspect is worse than no measurement.
    ///
    /// What is being measured is the batcher's response to the *timing and
    /// size distribution of a real program's writes*, and a pipe reproduces
    /// that. The caveat to carry: a ConPTY also interleaves escape sequences
    /// and may chunk differently, so treat these as the shape of the answer
    /// rather than the exact figures.
    fn measure(label: &str, mut cmd: std::process::Command) {
        let mut child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn");
        let mut reader = child.stdout.take().expect("stdout");

        let batches = Arc::new(Mutex::new(Vec::<usize>::new()));
        let seen = batches.clone();
        let sink = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(raw) = body {
                seen.lock().unwrap().push(raw.len());
            }
            Ok(())
        });

        let (chunks, pending) = mpsc::channel::<Vec<u8>>();
        let batcher = std::thread::spawn(move || batch_output(pending, sink));

        // Byte-for-byte the loop in `spawn`.
        let mut reads = Vec::<usize>::new();
        let mut buf = vec![0u8; COALESCE_MAX];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    reads.push(n);
                    if chunks.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        drop(chunks);
        batcher.join().expect("batcher");
        let _ = child.wait();

        report(label, &reads, &batches.lock().unwrap());
    }

    /// A file of plausible build-log lines, so the bulk case does not depend
    /// on a hashed build artefact existing.
    fn fixture(lines: usize) -> PathBuf {
        let path = std::env::temp_dir().join(format!("suite-pty-bulk-{}.txt", std::process::id()));
        let mut body = String::with_capacity(lines * 72);
        for i in 0..lines {
            body.push_str(&format!(
                "   Compiling some-crate-name v0.{i}.0 (/home/u/.cargo/registry/src/x)\n"
            ));
        }
        std::fs::write(&path, body).expect("write fixture");
        path
    }

    #[test]
    #[ignore = "measurement, not a check; run with --ignored --nocapture"]
    fn measure_batch_sizes() {
        // Throughput ceiling: ~2 MB as fast as the OS will carry it, which is
        // what `cargo build` output or `cat` of a large file looks like.
        let bulk_file = fixture(30_000);
        let mut bulk = std::process::Command::new("cmd.exe");
        bulk.arg("/c").arg("type").arg(&bulk_file);
        measure("bulk — 2 MB of build-log lines", bulk);
        let _ = std::fs::remove_file(&bulk_file);

        // Realistic developer tool output: many short lines, produced as fast
        // as the tool can manage.
        let mut tool = std::process::Command::new("cargo");
        tool.arg("tree");
        measure("tool — cargo tree", tool);

        // The adversarial case for coalescing: a slow producer whose every
        // write lands alone, so no batch can ever reach 1 KB. This is the
        // shape of an interactive prompt, and the case where the channel is
        // expected to be *worse* than the base64 event it replaced.
        let mut trickle = std::process::Command::new("powershell.exe");
        trickle
            .arg("-NoProfile")
            .arg("-Command")
            .arg("1..25 | ForEach-Object { Write-Output \"line $_\"; Start-Sleep -Milliseconds 40 }");
        measure("trickle — 25 writes, 40ms apart", trickle);
    }
}
