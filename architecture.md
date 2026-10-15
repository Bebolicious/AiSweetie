# Architecture

This document explains what the suite is, how it is built, and — more importantly — *why* each
decision went the way it did. The code carries the what; the reasoning has until now lived only in
doc comments and in conversations. This is the place it belongs.

Companion document: [`ROADMAP.md`](ROADMAP.md) for what is not built yet and in what order it lands.
The originating brief is [`build-prompt.md`](build-prompt.md), kept verbatim for historical record.

---

## 1. What this is

A fullscreen, keyboard-first development shell. You launch it at the start of a work day and it is
the only program you need: no taskbar, no window chrome, no alt-tabbing out to a terminal.

It boots into a **home screen** of day-to-day widgets. Four **edges** — top, right, bottom, left —
each hold exactly one module. Press the arrow key toward an edge, or click its glowing rail, and the
whole world slides that way with a spring overshoot; the module fills the screen. Escape slides back.

Four invariants settle every design argument. They come from `build-prompt.md`:

1. **Frame-perfect swap animation.** It is the signature interaction. Nothing is allowed to make it
   stutter.
2. **Keyboard-first.** The mouse works, but nothing *requires* it.
3. **Density over decoration.** Every panel earns its space. No empty boxes — which is why the home
   screen currently ships fewer widgets than the mock shows, rather than shipping placeholders.
4. **Modules genuinely interchangeable.** Any module must work on any edge and look native there.

Invariant 4 is the load-bearing one. It is the reason the module contract gives a module no say in
its own geometry, and the reason edge colors follow the *direction* rather than the module.

---

## 2. Stack, and why each piece won

| Layer | Choice | Why it won |
|---|---|---|
| Shell runtime | **Tauri 2** (Rust core, webview UI) | Runtime module hot-swap decided it: a webview makes modules `import()`-able JS bundles. Native dylibs and WASM components cannot match that ergonomically. Electron was the real alternative — it bundles Chromium, so blur and transform rendering are identical on every platform — but costs ~150 MB and a JS backend. |
| UI | **Solid + JSX** | No virtual DOM; fine-grained reactivity suits dense, high-frequency panels. The prototype was React 18, but tokenizing the mock meant rebuilding from primitives anyway, so the migration cost was already sunk. |
| Terminal | **`@xterm/xterm`** + WebGL addon; PTYs owned by Rust via **`portable-pty`** | Writing terminal emulation is a multi-year project. Multiplexing happens in-process rather than shelling out to tmux, because shelling out forfeits control of pane geometry — and pane geometry is the module's whole point. |
| Git | **`git` CLI**, parsed | Hunk-level staging is the deciding feature, and libgit2 handles partial-hunk staging badly. Generating a patch and feeding it to `git apply --cached` is what lazygit and gitui do too. |
| Module system | **In-process ES modules** | Simplest thing that permits runtime swap. Accepted cost: a broken module can take down the shell. Tolerable while the module set is ours; the contract is shaped so sandboxed iframes remain possible later. |
| Animation | **CSS transform + bezier** | One composited layer, GPU-driven, no JS running during the swap. A hand-rolled spring integrator would put JavaScript on the critical path of the one interaction that must never stutter. |
| AI | **Anthropic API direct from Rust** (planned) + **Claude Code as subprocess** (today) | Two paths for two jobs — see §13. |
| Config | **TOML via serde**, `directories` crate | Human-editable, diffable, and the file is part of the product: you are expected to read it. |
| Platform | **Windows and Linux, both first-class**; macOS later | These are the two machines the app is used on daily. The expensive divergences are PTY (ConPTY vs forkpty — absorbed by `portable-pty`), autostart, and fullscreen-without-chrome. |

**Known risk:** `backdrop-filter` performance on Linux/WebKitGTK, since the design blurs nearly every
panel. Mitigated by the panel-blur toggle and the `[data-blur="off"]` token override (§5).

**Known limitation:** "launches at boot" on Windows is a borderless always-on-top window plus a
registry `Run` key — not a true exclusive fullscreen surface. Shell replacement (swapping
`explorer.exe`) is out of scope: it breaks recovery when the app crashes.

---

## 3. Repo layout

```
aisweete/
├── architecture.md              ← this file
├── ROADMAP.md                   ← what is not built yet
├── build-prompt.md              ← the originating brief, kept verbatim
├── index.html                   ← Vite entry: #root + /src/index.tsx
├── vite.config.ts               ← the @suite/module alias lives here
│
├── packages/suite-module/
│   └── index.ts                 ← THE module contract. The most important file in the repo.
│
├── src/
│   ├── index.tsx                ← mounts App, calls registerBuiltins()
│   ├── design/                  ← tokens.css, shell.css, common.css, settings.css
│   ├── home/                    ← Home.tsx, Clock.tsx, Projects.tsx, PromptPill.tsx
│   ├── shell/                   ← the world, services, and chrome (§4, §7, §8)
│   └── modules/<id>/            ← one directory per module (§10)
│
├── src-tauri/
│   ├── tauri.conf.json          ← window, bundle, security
│   ├── capabilities/default.json
│   └── src/                     ← lib.rs, pty.rs, git.rs, fsx.rs, agents.rs (§9)
│
└── ui-mock/                     ← the Design Compiler prototype + five reference PNGs
```

Modules import the contract by **package name**, not relative path:

```ts
// vite.config.ts
alias: { "@suite/module": fileURLToPath(new URL("./packages/suite-module/index.ts", import.meta.url)) }
```

That alias is not cosmetic. It means a module's source has no structural dependency on living inside
this repo — a prerequisite for third-party modules later.

`ui-mock/AI Suite Prototype.dc.html` is a working Design Compiler prototype, not a static mock. Its
`support.js` runtime is present but the file is a 1920×1080 fixed-size world, so treat it as a
reference for *intent*, not a target for pixel-matching. Where the mock and this document disagree,
this document wins; where the mock and `build-prompt.md` disagree, the brief wins.

---

## 4. The world: navigation and animation

**File: `src/shell/track.ts`**

The world is a 3×3 grid of full-viewport cells. Home sits at the center; each module parks one cell
out in its own direction.

```
        ┌─────────┐
        │  top    │   [1,0]
┌───────┼─────────┼───────┐
│ left  │  HOME   │ right │   [0,1] [1,1] [2,1]
└───────┼─────────┼───────┘
        │ bottom  │   [1,2]
        └─────────┘
```

Sliding "toward the top edge" is literally moving the world *down* by one cell. A module with no edge
assigned parks at `OFF_WORLD = [4,4]`, outside the grid, unreachable but still mounted.

Two properties make the swap cheap:

- **Only the track transforms.** Nothing inside a cell animates. One promoted compositor layer moves;
  content is static. This is what keeps the signature interaction on the GPU.
- **Percentages, not pixels.** `CELL = 100 / 3` and the track is 300% of the viewport in both axes.
  The prototype hardcoded 1920/1080; using percentages is what makes the layout *fluid* rather than
  *scaled*. On a 4K display this means more information, not bigger text.

```ts
export function trackTransform([col, row]) {
  return `translate3d(${-col * CELL}%, ${-row * CELL}%, 0)`;
}
```

### The curve

One curve, defined once in tokens, and every edge pulls from it:

```css
--swap-ms: 440ms;
--swap-ease: cubic-bezier(0.28, 1.22, 0.36, 1);  /* overshoot ≈1.06 */
--swap-flat-ms: 260ms;                            /* bounce off */
--swap-flat-ease: cubic-bezier(0.4, 0, 0.2, 1);
```

> **Note on a red herring.** The prototype's git-diff and scratchpad widgets display strings like
> `Spring::new(0.42, 1.06)` and `320ms`. Those are *fake in-mock content* — filler text meant to look
> like a developer's screen — not specification. The real values are the two bezier pairs above.

**File: `src/shell/nav.ts`** — `view()` and `moving()` signals; `go()` sets a 460 ms settle timer, just
past the 440 ms curve so `moving` covers the overshoot too.

### The return-arrow rule

From an edge, pressing the arrow that points *back* toward home returns home, rather than leaping to
the opposite module. Looking at the top module and pressing Down goes home — it does not jump to the
bottom module. `BACK_FROM` in `track.ts` encodes this, and `App.tsx` applies it:

```ts
const current = view();
if (current !== "home" && BACK_FROM[current] === edge) nav.home();
else go(edge);
```

`FACES_HOME` is the same mapping under a second name, used for placing the return rail on whichever
side of a module's screen points at home.

---

## 5. Design system

**File: `src/design/tokens.css`**

The mock encodes its visual system as ~700 lines of duplicated inline styles. `tokens.css` is that
same system named once. Nothing in it is invented — every value traces to the prototype.

Deliberately **single-theme**: the compositor aesthetic commits to dark.

- **Ground** — `--bg-void: #05070a` behind everything (and the settings scrim), `--bg-screen: #0a0d12`
  as each cell's base. Panels are `rgba(17,23,32,.72)` with `backdrop-filter: blur(14px)`.
- **Strokes** — `--line: #1f2937` default border, `--line-bright: #2b3a4d` for anything interactive
  at rest. Focused panel: 2px accent border plus a glow.
- **Ink ramp**, brightest to faintest — `#e6edf6` (the value you came to read) → `#c9d6e4` (body) →
  `#8896a8` → `#5d6b7d` (labels) → `#3d4a5c` → `#2b3a4d`.
- **Accents** — teal `#4fd6be`, blue `#7aa2f7`, violet `#bb9af7`, amber `#e0af68`, green `#9ece6a`,
  red `#f7768e`. Semantic tokens (`--ok`, `--warn`, `--bad`, diff gutters) are defined *separately*
  from accents even where they share a value, so changing "green" never changes "ok".
- **Geometry** — 14px gutter between floating panels, 22px screen padding, radii 10 (panel) / 8
  (inner) / 7 (chip) / 6 (small) / 99px (pill).
- **Type** — JetBrains Mono throughout. Labels 11px uppercase with `0.14em` tracking; clock 64px.

### Edge hues follow direction, never module

```css
--edge-top: var(--teal);
--edge-right: var(--violet);
--edge-bottom: var(--blue);
--edge-left: var(--amber);
```

Swapping two modules between edges must **not** move the color. The hue tells you *where you are*;
the header tells you *what you are looking at*. If the hue traveled with the module, the spatial
memory that makes the navigation fast would be destroyed.

### Performance escape hatches

Three toggles in Settings → Performance, surfaced as `data-*` attributes on `:root` by
`src/shell/prefs.ts`, where the CSS reads them:

| Toggle | Attribute | Effect |
|---|---|---|
| Hardware acceleration | `data-accel` | Drops the promoted compositor layer when off |
| Panel blur | `data-blur` | `[data-blur="off"]` zeroes all three blur radii **and raises panel opacity to .94** — without blur, translucency alone reads as muddy |
| Bounce | `data-bounce` | Swaps the overshoot curve for the flat 260 ms ease |

`prefers-reduced-motion: reduce` collapses `--swap-ms` to 1 ms unconditionally.

---

## 6. The module contract

**File: `packages/suite-module/index.ts`** — the single most important file in the repo.

> A module renders into a container it does not own, at a size it does not choose, in a hue it is
> handed. That constraint is the whole point.

```ts
export interface SuiteModule {
  readonly id: string;       // stable identity; the key written to config.toml
  readonly title: string;    // rendered by the shell in the header — not by the module
  readonly version: string;

  mount(container: HTMLElement, ctx: ModuleContext): void | Promise<void>;
  unmount(): void | Promise<void>;

  keymap(): Binding[];       // declarative, so Settings can enumerate and rebind everything
  status(): StatusSummary;   // read by home and the header. Cheap and synchronous.
}
```

### `ModuleContext` — what a module is given

```ts
export interface ModuleContext {
  readonly edge: () => Edge;      // supplied, never chosen
  readonly accent: () => string;
  readonly project: () => Project | null;   // shell-level; see §12
  readonly bus: Bus;
  readonly focus: FocusScope;
  readonly nav: Nav;
}
```

`edge`, `accent` and `project` are **getters, not values**. Reassigning an edge, or switching
project, re-supplies them without a remount — which matters because a terminal module carries live
PTYs. `project` is null until the host has answered and always null in the browser dev build, so a
module treats null as "no project" rather than as an error.

### `status()` is synchronous on purpose

```ts
interface StatusSummary {
  header: string;  // module header: "aisweete / feat/edges · 4 changed"
  home: string;    // one line for the home edge map: "feat/edges · 4 dirty"
  tone?: "idle" | "active" | "attention";
}
```

The home screen polls this for all four modules. If it were async, home would render four loading
spinners every time you returned to it. Modules keep a cached snapshot and return it immediately.

### `FocusScope` — the global focus model

Bare keys are commands **only when no text input has focus**. `claimText(el)` registers a text
surface and returns a disposer; while one is focused the shell stops routing bare keys. This is what
keeps `,` from opening Settings mid-sentence, and what lets git's `c`/`p`/`a` and explorer's `/`/`f`
be single letters at all. Chords with a real modifier still route. Shift alone does not count as a
modifier — `shift+G` is still typing.

### The bus is a closed union, deliberately

```ts
export interface BusEvents {
  "file.open":   { path: string; line?: number };
  "git.stage":   { path: string; hunk?: number };
  "agent.spawn": { prompt: string; cwd: string };
}
```

Fully typed and discoverable while the module set is ours. An open channel gets added *alongside*
this — not replacing it — when third-party modules become real. The bus is implemented and tested but
**no module currently emits or subscribes**; the mock's `open in git ↑` / `send to agent` /
`stage in git ↑` handoffs are roadmap items (ROADMAP 0.7).

### Planned additions

One extension the v1 gate still requires. Documented here so the contract and the roadmap agree:

```ts
// ROADMAP 0.2 — the doctor layer (§11)
preflight(): Promise<Check[]>;
```

`project` on `ModuleContext` was the other planned addition and has landed (ROADMAP 0.4, §12).

---

## 7. Registry and module lifecycle

**File: `src/shell/registry.ts`** — a Solid signal holding `SuiteModule[]`, with `register`,
`unregister`, and `get`. Duplicate ids are warned about and ignored.

`loadFromPath` is **not implemented**. Vite cannot dynamic-import an arbitrary disk path; this needs
the Rust side to serve module bundles over a custom protocol first.

**File: `src/shell/ModuleFrame.tsx`** — one module in its cell. Two subtleties:

- **The frame is keyed to the module, not the edge.** Reassigning an edge moves this element to a
  different cell rather than remounting it. A terminal module carries live PTYs and a swap must not
  kill them.
- **Keymaps register on view, not on mount.** `createEffect` registers `props.mod.keymap()` only
  while `view() === edge()`. That is what lets two modules both claim `j` without conflict.

### Known behaviour: the HMR registry gap

This is the single most confusing thing about developing on this codebase, so recognize it rather
than debugging it.

**Symptom:** you edit a module's source while the app is running. The module frame renders its header
but an **empty body**, and the header shows the *previous* version's `status()` string.

**Cause:** `registerBuiltins()` in `src/modules/index.ts` runs once at boot and stores a *constructed*
instance in the registry. Vite HMR replaces the module file and solid-refresh disposes the old render
root — but nothing re-instantiates the registry entry or re-runs `ModuleFrame`'s `onMount`. The
registry keeps pointing at a dead instance.

**Workaround today:** restart `npm run tauri dev`. Nothing is wrong with your code.

**Real fix:** `registry.reload(id)` — unmount, re-import with a cache-busting query, re-register,
remount — with the dev build hooking `import.meta.hot.accept` into it. This is the same machinery
Settings' "load from path…" needs, so it is not throwaway work. ROADMAP 0.3.

---

## 8. Shell services

All in `src/shell/`.

**`keymap.ts`** — a layered router. `register(bindings)` pushes a layer and returns a disposer;
**later layers win**, so a focused module can shadow a global key. `chord(e)` normalizes an event to
a string like `mod+k`, where `mod` is Cmd on macOS and Ctrl elsewhere — bindings stay
platform-neutral in `config.toml`. Two ordering rules in `handle`:

1. Escape unwinds one level at a time: if a text surface is focused, Escape leaves the text *first*
   and does not also navigate home.
2. While something holds text focus, only chords with a real modifier are commands.

**`focus.ts`** — implements `FocusScope`; `blurActiveText()` backs rule 1 above.

**`bus.ts`** — typed emitter over `BusEvents`. Implemented, tested, unused (see §6).

**`prefs.ts`** — the three performance signals plus `syncPrefsToDom()`. In-memory only today;
persistence is ROADMAP 0.1.

**`project.ts`** — `activeProject`, `recentProjects`, `openProject(path)` and `bootProject()`, which
seeds from `fs_cwd` before the first render so the first terminal pane spawns inside the project.
In-memory for the same reason as `prefs.ts`. Tested in `project.test.ts`.

**`host.ts`** — a thin wrapper over the Tauri window API and the shell's own host calls (`cwd`,
`home`, `listDirs`), guarded by `"__TAURI_INTERNALS__" in window`. This is quietly one of the
highest-leverage files: because every OS call degrades to a no-op, the entire frontend runs in a
plain browser via `npm run dev`. Layout iteration never waits on a Rust rebuild.

**`context.ts`** — the singleton `router` and `bus` instances.

**`App.tsx`** — owns the track element and the global keymap layer:

| Keys | Action |
|---|---|
| `up` `right` `down` `left` | Go to that edge, with the return-arrow rule |
| `escape` | Home |
| `,` | Open Settings |
| `f11` | Toggle fullscreen |
| `mod+q` | Quit |

`Home.tsx` adds one key of its own, registered only while home is in view (the same rule a module's
keymap follows, so modules remain free to use it): `o` opens the project picker.

When Settings is open it pushes a layer that closes on Escape and **swallows the four arrows**, so the
world cannot slide out from under the modal.

**`Rail.tsx`** — the edge rails: a 5px bar with a `transparent → hue → transparent` gradient inside a
22px hit area.

**`useStatus.ts`** — polls a module's `status()` for the header and home.

**`paths.ts`** — path manipulation, cross-platform. Tested in `paths.test.ts`.

---

## 9. The Rust core

> The Rust side owns everything that touches the OS: PTYs, git, the filesystem, and agent
> subprocesses. The webview owns pixels and nothing else. — `src-tauri/src/lib.rs`

**20 commands**, registered in `lib.rs`:

| File | Commands | Notes |
|---|---|---|
| `pty.rs` | `pty_spawn` `pty_write` `pty_resize` `pty_kill` | `portable-pty` abstracts ConPTY and forkpty behind one interface |
| `git.rs` | `git_root` `git_status` `git_branches` `git_log` `git_diff` `git_diff_untracked` `git_apply_patch` `git_stage_file` `git_commit` | Shells out to `git` and parses |
| `fsx.rs` | `fs_list` `fs_read` `fs_home` `fs_cwd` | |
| `agents.rs` | `agent_spawn` `agent_kill` `agent_available` | |

`probe.rs` is a support module rather than a command surface: it locates
external binaries, and is the first piece of the doctor layer (§11) to exist.

Five design notes worth knowing before you touch these files:

- **PTY output crosses to the webview as base64, not `String`.** A PTY emits *bytes*, and a read can
  land midway through a multi-byte UTF-8 sequence. Decoding in Rust would corrupt exactly the
  box-drawing and emoji output that a terminal module exists to render. The frontend hands raw bytes
  to xterm, which already knows how to reassemble them.
- **Hunk staging generates a patch and runs `git apply --cached`.** Deliberately not libgit2/gix.
  The patch is rebuilt in TypeScript (`src/modules/git/diff.ts`) from the parsed unified diff.
- **`git diff --no-index` exits 1 when files differ**, which is the normal case for untracked-file
  diffs. `git_diff_untracked` treats a nonzero exit with empty stderr as success.
- **`fs_cwd` honors a `SUITE_PROJECT` environment variable**, falling back to the working directory
  stepped up out of `src-tauri` (where `tauri dev` starts the binary). It is called exactly once, at
  boot, to seed the active project (§12); nothing else reads it.
- **Finding a binary is not one PATH lookup** (`probe.rs`). The PATH this process inherits is not the
  PATH the user sees in their terminal: a graphical session gets the login environment, which on
  Debian/Ubuntu usually includes `~/.local/bin` but never what nvm, pyenv or asdf export from
  `~/.bashrc` — that file is only read by *interactive* shells. So a tool installed minutes ago works
  under `npm run tauri dev` and is invisible when the same build is launched from an icon.
  `probe::resolve` therefore tries, in cost order: an explicit override, the inherited PATH, known
  per-user install directories, and finally `$SHELL -lc 'command -v <bin>'`. Only the last step
  spawns a process, and callers cache the result (`agents::claude_path`). An explicit override that
  does not resolve fails rather than falling back — silently running a *different* binary than the
  one configured is worse than an error.

**Window config** (`tauri.conf.json`): `fullscreen: true`, `decorations: false`, `theme: "Dark"`,
identifier `com.aisweete.suite`. `csp: null` — this must be tightened before any third-party module
can be loaded.

---

## 10. The four v1 modules

All four are implemented front-to-back. None are stubs.

### Git — `src/modules/git/`

Three columns: `minmax(280px,340px) minmax(0,1fr) minmax(300px,400px)` — changed files (staged /
unstaged with ± counts, plus branches), the focused diff with per-hunk staging, and a right column for
the AI commit message and the commit graph.

| Key | Action |
|---|---|
| `j` / `k` | Next / previous hunk |
| `space` | Stage hunk under cursor |
| `a` | Stage whole file |
| `r` | Refresh repository |

`diff.ts` parses unified diff output and rebuilds single-hunk patches; `diff.test.ts` covers it. The
AI commit message, the diff footer strip (`fix callers`, `explain`), and the lane-colored graph are
roadmap items — they need the provider layer (§13).

### Terminal — `src/modules/terminal/`

Session tab bar plus a tiled grid of panes. Real PTYs, bottom-anchored output, xterm with the WebGL
addon.

| Key | Action |
|---|---|
| `mod+shift+s` / `z` / `w` / `t` | Split / zoom / close pane, new session |
| `mod+1` … `mod+5` | Switch to session 1–5 |

**These drifted from the mock deliberately.** The mock advertises bare `^S` / `^W` / `^Z` / `^T`, but
those are chords the shell inside the PTY expects to receive — `^W` deletes a word, `^Z` suspends.
Adding `shift` keeps the PTY's own keys intact.

`panes.ts` keeps a binary pane tree but renders it as a **flat** list of rects, so splitting a pane
does not unmount the live PTYs in its siblings. `panes.test.ts` covers the tree operations.

### Explorer — `src/modules/explorer/`

Terminal-like but clickable: `minmax(200px,260px) minmax(0,1.4fr) minmax(0,1.2fr)` — tree, columnar
listing (name / size / modified / git status), syntax-highlighted preview via highlight.js.

| Key | Action |
|---|---|
| `/` | Filter listing |
| `f` | Fuzzy jump |
| `backspace` | Parent directory |
| `.` | Toggle hidden files |

The bottom natural-language prompt ("rename `diff.rs` → `diff_view.rs` and fix imports") needs the
provider layer.

### Agents — `src/modules/agents/`

`minmax(260px,320px) minmax(0,1fr)` — a queue of agents with status, token counts and elapsed time,
beside a live transcript.

| Key | Action |
|---|---|
| `mod+enter` | New agent |
| `j` / `k` | Next / previous agent |
| `x` | Stop selected agent |

Agents are `claude` CLI subprocesses in headless mode emitting `stream-json`, one JSON object per
line, parsed by `stream.ts` in the frontend. Two consequences:

- **No API key handling here** — the CLI already owns authentication.
- **The transcript is the real event stream**, not scraped terminal output.

Spawned agents are **restricted to read-only tools by default**. An agent queue that can silently
edit the disk is not a feature anyone asked for; write access is opt-in per project (§12).

---

## 11. Resilience: the doctor layer

*Design. Not yet implemented — ROADMAP 0.2.*

The app is going to be handed to testers on machines that do not have `git`, do not have the `claude`
CLI, have no API key, or have Docker installed but not running. **A module whose dependency is
missing must explain itself and offer a fix.** It must never render blank, never throw into the
console, and never leave the user guessing which of the four tabs is broken.

This is a shell-level system rather than four separate error screens, because the failure mode is
identical every time and because the home screen needs to aggregate it.

### The contract addition

```ts
preflight(): Promise<Check[]>;

interface Check {
  id: string;                         // "git.binary", "agents.cli"
  label: string;                      // "git is installed"
  severity: "blocking" | "degraded" | "info";
  ok: boolean;
  detail?: string;                    // what was actually found: "git 2.42.0"
  remediation?: Remediation;
}

type Remediation =
  | { kind: "instructions"; summary: string; commands: PlatformCommands; docsUrl?: string }
  | { kind: "action"; label: string; run(): Promise<void> };   // "pick a folder…", "set API key"
```

`PlatformCommands` carries the right incantation per platform — `winget` / `choco` on Windows,
`apt` / `dnf` / `pacman` on Linux — so the panel shows a copyable command that actually works on
*this* machine rather than a generic "install git".

### Behaviour

- **`blocking`** — the module cannot function. `ModuleFrame` renders a **doctor panel in place of the
  module body**. The header, rails and navigation all keep working; you are never trapped.
- **`degraded`** — the module works with a feature missing (git present but `user.email` unset; no
  API key, so AI commit messages are off). Renders normally with a dismissible notice.
- **`info`** — surfaces only inside the doctor panel when you go looking.

The home edge map shows a health dot per edge, so one glance tells you what needs attention before
you navigate anywhere. Settings grows a "Diagnostics" group that runs every module's preflight at
once — the thing you ask a tester to screenshot.

### The v1 checks

| Module | Check | Severity | Remediation |
|---|---|---|---|
| Git | `git` on PATH | blocking | Platform install command |
| Git | active project is a repo | blocking | Action: `git init` here, or pick another folder |
| Git | `user.name` / `user.email` set | degraded | Action: set them inline (commit will fail otherwise) |
| Git | remote configured + credentials work | degraded | Instructions for adding a remote / credential helper |
| Terminal | a shell exists (`pwsh`/`powershell`/`cmd`; `$SHELL`/`bash`) | blocking | Action: pick a shell binary |
| Terminal | PTY spawns successfully | blocking | Detail surfaces the OS error; ConPTY needs Windows 10 1809+ |
| Explorer | active project path exists and is readable | blocking | Action: pick a folder |
| Agents | `claude` on PATH | blocking | Install instructions + docs link (`agent_available` already answers this) |
| Agents | `claude` is authenticated | blocking | Instructions: run `claude` once to log in |
| Agents | API key present (for non-CLI AI features) | degraded | Action: set key in Settings |

### What already exists

Two pieces of this landed ahead of the rest, because handing a build to a tester on Linux made them
immediately necessary:

- **`probe.rs`** — the generalized binary locator described in §9. One implementation, every module.
- **`agent_available`** returns a `ClaudeStatus { found, path, version, error }` rather than a bool,
  and the agents module renders three distinct states from it: not found, found-but-won't-run, and
  working. `SUITE_CLAUDE_PATH` overrides resolution. This is the shape every `Check` should take —
  the three failure modes need different advice, and a bool cannot carry that.

The rest of the layer — the `preflight()` contract method, the doctor panel in `ModuleFrame`, the
per-platform install commands, and the home-screen health dots — is still ROADMAP 0.2.

---

## 12. Projects and self-dev mode

*Projects: implemented, minus persistence — ROADMAP 0.4. Self-dev mode: design — ROADMAP 0.5.*

### Why projects are shell-level

The working directory used to come from `fs_cwd` alone, honoring `SUITE_PROJECT`: one directory for
the whole app, fixed at launch. Handling multiple projects properly cannot be solved inside the git
module: if git switches repo but the explorer tree, the terminal's working directory, and the agents'
`cwd` do not follow, the app is lying about where you are.

So a project is a shell concept, on `ModuleContext`:

```ts
interface Project {
  id: string;          // the normalized path today; config.toml's key later
  name: string;        // last path segment
  path: string;
  selfDev?: boolean;   // this is the suite's own repo
}
```

One `activeProject` signal in `src/shell/project.ts`, consumed by all four modules through
`ctx.project()`. The home Projects panel is the switcher. Switching re-scopes every module without a
restart — and because the frame is keyed to the module (§7), live PTYs survive it.

### How each module follows the switch

| Module | On switch |
|---|---|
| Git | Re-resolves the repository root from the new path; selection and hunk cursor reset |
| Explorer | Jumps to the project root; filter, selection and expanded tree reset |
| Agents | New agents spawn with the new `cwd`; running agents keep theirs |
| Terminal | New panes spawn in the new project; **running panes keep their directory** — a switch must never yank a live shell somewhere else |

Per-project terminal session restore (switch back and your panes are as you left them) is the part
of 0.4 still open.

### The picker

An in-app path input with Tab completion (`o` on home, or the chip), rather than the OS folder
dialog. A GTK or Win32 file chooser is a foreign, mouse-first window floating over a fullscreen app
whose premise is no window chrome. The input opens pre-filled with the active project's *parent*
directory, so sibling projects — the common case when you swap a lot — are one Tab away. `~` expands.
Enter opens the typed path when it is a readable directory, and otherwise takes the highlighted
suggestion. Escape is the shell's: it blurs the field, and blur closes the picker. The same picker is
what the doctor layer's "pick a folder" remediations (§11) will reuse.

### Persistence

Deliberately none yet. The active project and the recents list reset on restart, exactly as edge
assignment and the performance toggles do today. They hydrate from `[[projects]]` (§14) when ROADMAP
0.1 lands. Adding localStorage in the meantime would be the second persistence mechanism the roadmap
warns against.

### Self-dev mode

The one-and-done property: start the app once, then make it your own from inside itself.

Self-dev mode is a project with `selfDev: true` pointing at this repo. Three things turn on:

1. **Agent write-tools are enabled** for that project — the only place the read-only default is
   lifted, and it requires an explicit opt-in you can see in Settings.
2. **`registry.reload(id)` is wired to file changes** (ROADMAP 0.3), so editing a module's source
   updates it live. This closes the HMR gap in §7 and is the feature that makes editing-from-within
   feel real rather than theoretical.
3. **A terminal session preset** on `npm run tauri dev`, so the dev loop is one keystroke away.

The honest boundary: **module edits reload live; shell edits do not.** Changing `src/shell/`,
`packages/suite-module/`, or any Rust file still needs a restart — you are modifying the thing that is
doing the reloading. The in-app flow for those is "edit, commit, push, restart", which is still fully
inside the app.

---

## 13. The AI layer

Two paths, for two different jobs. Keeping both is a decision, not indecision.

**Claude Code as a subprocess** — *implemented.* The agents module. Long-running, multi-turn,
tool-using work where you want the full agent harness: file edits, test runs, its own context
management. The CLI owns authentication, so there is no key handling in our process, and
`stream-json` gives a structured event stream rather than scraped output.

**Anthropic API direct from Rust** — *not built; ROADMAP 0.6.* Short, structured, synchronous-feeling
calls embedded in a module's UI: the git commit message, the explorer's natural-language prompt, the
home prompt pill, the diff footer's `explain`. Spawning a whole agent for "write a commit message" is
absurd — it is one request with a known system prompt.

The provider interface lives in Rust, with SSE streaming, per-module system prompts, and a **token and
cost meter**. The meter is the reason this layer is Rust-side: every AI call in the app must pass
through one place that counts tokens, or the number on the home screen is a guess. A per-module JS
client would make that impossible to enforce.

When building against this, consult the `claude-api` skill for current model ids and pricing rather
than hardcoding from memory.

---

## 14. Config and state

*Partially implemented — the shape is settled, persistence is ROADMAP 0.1.*

Every setting currently lives in an in-memory Solid signal and resets on restart. The target:

```toml
# ~/.config/suite/config.toml
[edges]
top = "git"
right = "terminal"
bottom = "explorer"
left = "agents"

[performance]
hardware_accel = true
panel_blur = true          # set false on Linux/WebKitGTK if the swap stutters
bounce = true

[hotkeys]                   # overrides only; unlisted bindings keep their default
"git.stageHunk" = "space"
"terminal.split" = "mod+shift+s"

[[projects]]
name = "aisweete"
path = "~/Projects/aisweete"
self_dev = true

[ai]
provider = "anthropic"
# api_key is read from ANTHROPIC_API_KEY or the OS keychain — never written here

[modules]
paths = []                  # extra module bundle directories
```

Paths via the `directories` crate, with `$XDG_CONFIG_HOME/suite/config.toml` honored on Linux per the
original brief. On Windows this resolves under `%APPDATA%\com.aisweete.suite\`.

**The rule: changes apply live, the file is written on Settings close.** Config is part of the
product — you are expected to open it, read it, and hand-edit it. An unreadable config is a bug.

Secrets never land in the TOML.

---

## 15. Packaging and distribution

*ROADMAP 0.10.*

`tauri.conf.json` currently declares `"targets": "all"`, which should be narrowed per platform.

**Windows** — NSIS installer plus MSI, and the raw `target/release/suite.exe` serves as the portable
build. The WebView2 runtime is the one real dependency; the default `downloadBootstrapper` keeps the
installer small but needs network on first run. For handing a build to a tester on an unknown machine,
the embedded bootstrapper is worth the size.

**Linux** — AppImage plus `.deb`. Runtime dependency is `webkit2gtk-4.1`; the AppImage bundles most of
it but not all, so the doctor layer should check for it rather than letting the window fail to create.
This is also the platform where panel blur is most likely to need switching off.

**macOS** — later. Needs a Mac to build and an Apple developer account to notarize.

**Autostart** — opt-in from Settings, not default. A borderless always-on-top window plus a registry
`Run` key on Windows or a `~/.config/autostart/*.desktop` entry on Linux. Explicitly *not* a shell
replacement: if the app crashes you must still be able to reach your desktop.

---

## 16. Testing

Vitest with happy-dom, configured in `vite.config.ts`. Note `solid({ hot: !process.env.VITEST })` —
solid-refresh is disabled under test, because HMR instrumentation interferes with component identity
in assertions.

```
npm test          # vitest run
cargo test        # in src-tauri/
```

| Suite | Covers |
|---|---|
| `src/shell/paths.test.ts` | Cross-platform path manipulation |
| `src/shell/project.test.ts` | Path normalization, project naming, recents ordering and bound |
| `src/shell/shell.test.tsx` | Navigation, the return-arrow rule, keymap layering, the bus |
| `src/modules/git/diff.test.ts` | Unified-diff parsing and single-hunk patch reconstruction |
| `src/modules/git/switch.test.tsx` | A mounted git module re-scopes when the active project changes (mocked host) |
| `src/modules/explorer/switch.test.tsx` | A mounted explorer lands at the new project root after a switch (mocked host) |
| `src/modules/terminal/panes.test.ts` | Pane tree split / close / zoom |
| `src/modules/explorer/api.test.ts` | Listing and filtering |
| `src/modules/agents/stream.test.ts` | `stream-json` line parsing |
| `src-tauri/src/git_tests.rs` | Git command construction and output parsing |

The highest-value gap: the Rust PTY layer has no tests (hard to test without a real PTY — a
spawn-echo-read integration test is the realistic target). The two `switch.test.tsx` files are the
first tests to drive a module through mount → change → unmount against a mocked host; the pattern
is worth extending.

---

## 17. Known gaps

Everything here is tracked in [`ROADMAP.md`](ROADMAP.md) Phase 0. Listed so that reading this document
does not leave you expecting features that do not exist.

| Gap | Where | Roadmap |
|---|---|---|
| No config persistence — all settings reset on restart | `prefs.ts`, `edges.ts` | 0.1 |
| No doctor layer; missing dependencies surface as console errors | — | 0.2 |
| `registry.reload()` absent → the HMR gap in §7 | `registry.ts` | 0.3 |
| `loadFromPath` unimplemented (needs a Rust custom protocol) | `registry.ts` | 0.3 |
| Active project and recents reset on restart; no per-project terminal sessions | `project.ts` | 0.1, 0.4 |
| No AI provider layer → no AI commit message, no NL prompts, no cost meter | — | 0.6 |
| Bus implemented but unused; no cross-module handoffs | `bus.ts` | 0.7 |
| Home missing todo, calculator, system stats, scratchpad, hotkey chips | `src/home/` | 0.8 |
| Hotkey rebinding is display-only | `Settings.tsx` | 0.9 |
| No command palette (`mod+k`) | — | 0.9 |
| No autostart; `bundle.targets` still `"all"` | `tauri.conf.json` | 0.10 |
| `csp: null` — must tighten before third-party modules | `tauri.conf.json` | Phase 4 |

On the home screen specifically, the absence is a decision, not an oversight —
`src/home/home.css:1`:

> Only the widgets that are real live here — clock, projects, edge map, prompt. The rest of the
> mock's widgets arrive with their own slice; empty placeholder boxes would violate the one rule the
> design actually has.

---

## 18. Rules for module authors

The short list. Every one of these exists because breaking it breaks something visible.

1. **Do not choose your geometry.** You get a container. Fill it at any size. No fixed pixel
   dimensions, no assumptions about aspect ratio.
2. **Do not assume your edge.** Read `ctx.edge()` and `ctx.accent()` as getters, every time. They
   change under you without a remount.
3. **Claim text focus.** Any input, textarea or contenteditable must call `ctx.focus.claimText(el)`
   and dispose it on unmount. Skip this and the user's typing starts triggering commands.
4. **Keep `status()` cheap and synchronous.** Cache a snapshot; never do I/O in it. Home calls it for
   every module.
5. **Declare every binding in `keymap()`.** Do not attach your own `keydown` listeners to `window`.
   Bindings not declared cannot be shown, rebound, or shadowed correctly.
6. **Namespace your binding ids** as `<module>.<action>` — they are config keys.
7. **Clean up in `unmount()`.** Kill PTYs, abort fetches, clear intervals, dispose focus claims. Your
   module will be unmounted and remounted by `registry.reload()`.
8. **Survive a missing dependency.** Implement `preflight()` and return a `blocking` check rather than
   throwing. A module that cannot run should say why and how to fix it.
9. **Use the design tokens.** No hardcoded hex. A module with its own palette looks foreign on three
   of the four edges.
10. **Emit on the bus rather than reaching into another module.** Modules do not import each other.
