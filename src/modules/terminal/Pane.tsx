import { onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { createDisposers } from "../../shell/disposers";
import { hasPty, pty } from "./pty";

/** xterm's palette, pulled from the suite's tokens so panes match the shell. */
function themeFrom(el: HTMLElement) {
  const v = (name: string) =>
    getComputedStyle(el).getPropertyValue(name).trim() || undefined;
  return {
    background: "#00000000", // let the panel show through
    foreground: v("--ink"),
    cursor: v("--accent"),
    cursorAccent: v("--bg-screen"),
    selectionBackground: "rgba(122,162,247,.28)",
    black: v("--bg-screen"),
    red: v("--red"),
    green: v("--green"),
    yellow: v("--amber"),
    blue: v("--blue"),
    magenta: v("--violet"),
    cyan: v("--teal"),
    white: v("--ink"),
    brightBlack: v("--ink-faint"),
    brightRed: v("--red"),
    brightGreen: v("--green"),
    brightYellow: v("--amber"),
    brightBlue: v("--blue"),
    brightMagenta: v("--violet"),
    brightCyan: v("--teal"),
    brightWhite: v("--ink-bright"),
  };
}

/**
 * One pane: one xterm, one real PTY.
 *
 * xterm renders to its own canvas, so Solid never touches the hot path — the
 * framework's only job here is to create the element and get out of the way.
 */
export function Pane(props: {
  id: string;
  /**
   * Working directory for the shell. Read once, at spawn: a pane that is
   * already running keeps its directory when the active project changes —
   * a switch must never yank a live shell somewhere else.
   */
  cwd?: string;
  focused: boolean;
  onFocus: () => void;
  onExit: () => void;
}) {
  let host!: HTMLDivElement;

  onMount(() => {
    // xterm measures glyphs on a canvas, where CSS custom properties do not
    // resolve — `var(--font)` here silently falls back with wrong metrics.
    // Read the token's computed value instead.
    const fontFamily =
      getComputedStyle(host).getPropertyValue("--font").trim() ||
      '"JetBrains Mono", ui-monospace, monospace';

    const term = new Terminal({
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 10_000,
      theme: themeFrom(host),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // WebGL is a big win on dense output but is not available everywhere —
    // notably some Linux/WebKitGTK setups. Falling back is not an error.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      console.info("[terminal] WebGL unavailable, using canvas renderer");
    }

    // Ctrl+Shift chords belong to the multiplexer, not the shell. Returning
    // false stops xterm consuming them and lets them bubble to the router,
    // which is why the shell inside keeps Ctrl+Z, Ctrl+W and Ctrl+S.
    term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.shiftKey));

    fit.fit();

    const subs = createDisposers();

    if (hasPty()) {
      void (async () => {
        await subs.add(pty.onExit(props.id, () => props.onExit()));
        // Do not spawn a shell for a pane that is already gone — it would
        // outlive its only subscriber.
        if (subs.disposed) return;
        // The output channel is created inside spawn(), before the command is
        // sent, so there is no gap where the shell is live and unobserved.
        await pty.spawn(props.id, term.cols, term.rows, props.cwd, (bytes) =>
          term.write(bytes),
        );
        term.onData((d) => void pty.write(props.id, d));
      })();
    } else {
      term.writeln("\x1b[38;5;244mno PTY host — run under `npm run tauri dev`\x1b[0m");
    }

    // Keep the PTY's idea of the window the same as xterm's.
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (hasPty()) void pty.resize(props.id, term.cols, term.rows);
    });
    ro.observe(host);

    host.addEventListener("focusin", props.onFocus);
    host.addEventListener("mousedown", props.onFocus);

    onCleanup(() => {
      subs.dispose();
      ro.disconnect();
      if (hasPty()) void pty.kill(props.id);
      term.dispose();
    });
  });

  return <div class="pane__term" ref={host} />;
}
