import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Client side of the PTY bridge.
 *
 * Output arrives on a per-pane channel carrying raw bytes, which go straight
 * to xterm — it reassembles multi-byte UTF-8 across chunk boundaries, which is
 * why nothing here ever decodes to a string.
 *
 * The channel also removes two problems the old `pty://output` event had. It
 * was a broadcast, so every pane's handler saw every other pane's bytes and
 * discarded them here in JavaScript; and the subscription had to be awaited
 * *before* spawning, or the shell's first output had nowhere to land. A channel
 * is created before the invoke and belongs to one pane, so both go away.
 */

export const pty = {
  /**
   * Spawn a shell and start receiving its output.
   *
   * `onBytes` is wired up before the command is sent, so no output can be
   * produced before there is somewhere to put it.
   */
  spawn(
    id: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    onBytes: (bytes: Uint8Array) => void,
  ) {
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (buffer) => onBytes(new Uint8Array(buffer));
    return invoke<void>("pty_spawn", { id, cwd, cols, rows, output });
  },

  write(id: string, data: string) {
    return invoke<void>("pty_write", { id, data });
  },

  resize(id: string, cols: number, rows: number) {
    return invoke<void>("pty_resize", { id, cols, rows });
  },

  kill(id: string) {
    return invoke<void>("pty_kill", { id });
  },

  /**
   * Subscribe to the pane's shell exiting. Returns a disposer.
   *
   * Still a global event rather than a channel: it fires once in a pane's
   * entire life, so the broadcast costs nothing, and keeping it separate means
   * the output channel stays a pure byte stream with no tagging.
   */
  async onExit(id: string, fn: (code: number) => void): Promise<UnlistenFn> {
    return listen<{ id: string; code: number }>("pty://exit", (e) => {
      if (e.payload.id === id) fn(e.payload.code);
    });
  },
};

/** The suite runs in a plain browser during layout work; PTYs need Tauri. */
export const hasPty = () => "__TAURI_INTERNALS__" in window;
