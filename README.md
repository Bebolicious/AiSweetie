# suite

A fullscreen, keyboard-first development shell. You launch it at the start of a work day and it is
the only program you need: no taskbar, no window chrome, no alt-tabbing out to a terminal.

It boots into a home screen. Four edges — top, right, bottom, left — each hold exactly one module.
Press the arrow key toward an edge and the whole world slides that way with a spring overshoot;
the module fills the screen. Escape slides back.

```
                  ↑  git
          ┌───────────────────┐
          │        GIT        │
          │  branches · diff  │
          │   hunk staging    │
┌─────────┼───────────────────┼─────────┐
│ AGENTS  │       HOME        │ TERMINAL│
│ queue   │  clock · projects │  panes  │
│transcript│    edge map      │ sessions│
└─────────┼───────────────────┼─────────┘
← agents  │     EXPLORER      │ terminal →
          │ tree · preview    │
          └───────────────────┘
                  ↓  explorer

  440ms · cubic-bezier(.28,1.22,.36,1) · one composited layer
```

Nothing inside a cell animates. The track moves; content is static — which is what keeps the
signature interaction on the GPU. Edge hues follow the *direction*, never the module, so swapping
two modules between edges does not move the colour.

Modules are genuinely interchangeable: any module works on any edge and looks native there. It is
handed a container it does not own, at a size it does not choose, in a hue it is given.

- [`architecture.md`](architecture.md) — what it is, how it's built, and why each decision went the way it did
- [`ROADMAP.md`](ROADMAP.md) — what isn't built yet, and in what order it lands

---

## Status

Pre-v1. Phase 0 of the roadmap is the v1 release; it is not complete.

**Works, front to back:**

| | |
|---|---|
| The swap | Four edges, arrow keys and clickable rails, spring overshoot, reduced-motion aware |
| Git | Changed files with ± counts, branches, per-hunk staging, commit log |
| Terminal | Real PTYs, tiled pane tree, multiple sessions, xterm with the WebGL renderer |
| Explorer | Tree, columnar listing, syntax-highlighted preview, filter and fuzzy jump |
| Agents | `claude` CLI subprocesses in headless mode, live transcript, token and cost counts |
| Projects | Switch project and all four modules re-scope without a restart; live PTYs survive it |
| Edge assignment | Reassign any module to any edge from Settings; the frame moves rather than remounting |
| Failure containment | A module that throws loses its own cell and says so. The other three edges, the rails and `esc` keep working — which matters when the thing still running is your shells |

**Not yet — the honest list:**

| | Roadmap |
|---|---|
| **Nothing persists across a restart** — edges, performance toggles, active project, recents, terminal sessions, agent transcripts | 0.1, 0.4 |
| No doctor layer. Agents explains a missing or broken `claude` CLI, and git explains a directory that isn't a repository — but there is no `preflight()`, no platform-specific install guidance, and no health indicator on the home screen | 0.2 |
| Editing a module's source needs a restart — `registry.reload()` does not exist yet | 0.3 |
| Self-dev mode (agent write-tools, file-watch reload, dev preset) | 0.5 |
| No AI provider layer, so no AI commit message, no natural-language prompts, no cost meter | 0.6 |
| The bus exists and is tested, but no module emits or subscribes — no cross-module handoffs | 0.7 |
| Home is missing todo, calculator, system stats, scratchpad, hotkey chips | 0.8 |
| Hotkey rebinding is display-only; no `mod+k` command palette | 0.9 |
| No installers, no autostart | 0.10 |

Agents run with **read-only tools** — `Read`, `Glob`, `Grep`, `WebFetch`. They cannot edit your
files. Lifting that is per-project and opt-in, and does not exist yet (0.5).

Single dark theme, by design. Windows and Linux are both first-class; macOS is later.

---

## Run it

**Prerequisites**

- Node 20 or newer (18 also works)
- Rust stable — 1.77.2+, which is Tauri 2's minimum
- `git` on `PATH` — the git module needs it
- Windows: WebView2 (ships with Windows 11 and current Windows 10) and MSVC build tools
- Linux: `webkit2gtk-4.1` and a C toolchain
- Optional: the [`claude` CLI](https://code.claude.com/docs/en/overview) for the agents module. It owns its own
  authentication, so no API key is stored here.

**Commands**

```sh
npm install

npm run tauri dev       # the app
npm run dev             # frontend only, in a browser — see below
npm test                # vitest
npm run tauri build     # release build

cd src-tauri && cargo test
```

`npm run dev` runs the entire frontend in a plain browser. Every OS call degrades to a no-op, so
layout and design work never waits on a Rust rebuild; the modules render their "needs the Tauri
host" state instead. This is the fast loop.

`SUITE_PROJECT` points the app at a directory other than the one it was launched from.
`SUITE_CLAUDE_PATH` overrides `claude` resolution when it is installed somewhere unusual — a version
manager, a custom npm prefix.

---

## Keys

`mod` is Ctrl on Windows and Linux, Cmd on macOS.

**Shell** — always live

| Key | Action |
|---|---|
| `↑` `→` `↓` `←` | Go to that edge. From an edge, the arrow pointing back at home returns home rather than leaping to the opposite module |
| `escape` | Home. If a text field has focus, leaves the field first |
| `,` | Settings |
| `f11` | Toggle fullscreen |
| `mod+q` | Quit |

**Home**

| Key | Action |
|---|---|
| `o` | Open a project — a path input with Tab completion, not an OS folder dialog |

**Git**

| Key | Action |
|---|---|
| `j` / `k` | Next / previous hunk |
| `space` | Stage the hunk under the cursor |
| `a` | Stage the whole file |
| `r` | Refresh the repository |

**Terminal**

| Key | Action |
|---|---|
| `mod+shift+s` | Split pane |
| `mod+shift+z` | Zoom pane |
| `mod+shift+w` | Close pane |
| `mod+shift+t` | New session |
| `mod+1` … `mod+5` | Switch to session 1–5 |

Shift is deliberate. Bare `^S`, `^W`, `^Z` and `^T` belong to the shell running inside the
PTY — `^W` deletes a word, `^Z` suspends — so the multiplexer takes the shifted chords instead.

**Explorer**

| Key | Action |
|---|---|
| `/` | Filter the listing |
| `f` | Fuzzy jump |
| `backspace` | Parent directory |
| `.` | Toggle hidden files |

**Agents**

| Key | Action |
|---|---|
| `mod+enter` | New agent |
| `j` / `k` | Next / previous agent |
| `x` | Stop the selected agent |

Bare keys are commands only when no text field has focus, so `,` does not open Settings
mid-sentence and git's `a` does not stage a file while you are typing. Chords with a real modifier
always route. Every binding is declared rather than bound ad-hoc, which is why Settings can list
them all — and why the command palette is nearly free once rebinding lands (0.9).

---

## If the swap stutters

Settings → Performance, in the order worth trying:

| Toggle | Effect |
|---|---|
| **Panel blur** | Zeroes every backdrop-filter radius and raises panel opacity to compensate. The first thing to turn off — heavy blur is what falls over first, especially on Linux/WebKitGTK |
| **Bounce** | Swaps the 440ms overshoot for a flat 260ms ease |
| **Hardware acceleration** | Drops the promoted compositor layer |

`prefers-reduced-motion: reduce` collapses the swap to 1ms unconditionally.

---

## Writing a module

A module imports one thing, by package name:

```ts
import type { SuiteModule, ModuleContext } from "@suite/module";

export function notesModule(): SuiteModule {
  return {
    id: "notes",            // stable; this is the key written to config.toml
    title: "NOTES",         // the shell renders this in the header, not you
    version: "0.1.0",

    mount(container, ctx) {
      // `mountView`, not Solid's `render`: same signature, but it puts an
      // error boundary inside your own reactive root, which is the only
      // place anything you throw can be caught.
      dispose = mountView(() => <NotesView ctx={ctx} />, container);
    },
    unmount() { /* kill PTYs, abort fetches, clear intervals */ },

    keymap() { return []; },                       // declarative, so Settings can rebind it
    status() { return { header: "", home: "" }; },  // cheap and synchronous; home polls it
  };
}
```

The contract is [`packages/suite-module/index.ts`](packages/suite-module/index.ts) — one file, and the most important one in the
repo. The eleven rules for authors are in [`architecture.md §18`](architecture.md); the short version is: do not choose your
geometry, do not assume your edge, claim text focus for every input, keep `status()` synchronous,
declare every binding, clean up in `unmount()`, render through `mountView`, and use the design
tokens.

Third-party modules are Phase 4 and need sandboxing first. A module shares the shell's process, so
while a *render* error is contained, an infinite loop or a memory leak is not — an accepted cost
only while we are the only author.

---

## Layout

```
packages/suite-module/   the module contract
src/
  design/                tokens.css and the shell's own styles
  shell/                 the world, services, chrome
  home/                  home screen widgets
  modules/<id>/          one directory per module
src-tauri/src/           pty · git · fsx · agents · probe · task
```

The Rust side owns everything that touches the OS: PTYs, git, the filesystem, agent subprocesses.
The webview owns pixels and nothing else. Commands that touch the OS are `async` shims over
synchronous functions run off the main thread — a blocking call on the thread pumping the window is
a stutter in the swap.

---

## Licence

MIT, per `package.json`. No `LICENSE` file has been added yet.
