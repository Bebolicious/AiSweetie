import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Client side of the PTY bridge.
 *
 * The Rust side sends base64 because a PTY read can land mid-way through a
 * multi-byte UTF-8 sequence; we decode to bytes and hand those straight to
 * xterm, which reassembles them correctly across chunk boundaries.
 */

export interface PtyOutput {
  id: string;
  data: string;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const pty = {
  spawn(id: string, cols: number, rows: number, cwd?: string) {
    return invoke<void>("pty_spawn", { id, cwd, cols, rows });
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

  /** Subscribe to output for one pane. Returns a disposer. */
  async onOutput(
    id: string,
    fn: (bytes: Uint8Array) => void,
  ): Promise<UnlistenFn> {
    return listen<PtyOutput>("pty://output", (e) => {
      if (e.payload.id === id) fn(decode(e.payload.data));
    });
  },

  async onExit(id: string, fn: () => void): Promise<UnlistenFn> {
    return listen<{ id: string }>("pty://exit", (e) => {
      if (e.payload.id === id) fn();
    });
  },
};

/** The suite runs in a plain browser during layout work; PTYs need Tauri. */
export const hasPty = () => "__TAURI_INTERNALS__" in window;
