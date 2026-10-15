# Build prompt — OS-wide AI development suite

Paste everything below into a fresh Claude conversation (Claude Code works best, since it can scaffold the repo directly). It is written as an instruction to Claude, not as documentation.

---

## Instruction to Claude

I want to build a fullscreen, keyboard-first development shell that launches at boot and is the only program I use during a work day. Before you write any code, ask me the framework questions in "Step 0" below and wait for my answers.

### What the program is

A single fullscreen application — no OS taskbar, no window chrome, no start menu in front of it. It boots into a **home screen** of day-to-day widgets. Four **edges** (top, right, bottom, left) each hold one module. Clicking an edge rail, or pressing the arrow key toward it, slides the whole world in that direction with a spring overshoot (~440ms, overshoot ~1.06) and the module fills the screen. Escape slides back home.

**Modularity is the core constraint:** every module renders into an identical container, so any module can be assigned to any edge and looks and behaves the same there. Modules are hot-swappable at runtime without a restart. Which module sits on which edge is user configuration, not code.

### Modules for v1

1. **Git** — three-column layout: changed-files list (staged / unstaged with +/− counts and branch list), a focused diff pane with hunk-level staging (space stages the hunk under the cursor), and a right column holding an AI-generated commit message (accept / regenerate / edit) plus an ASCII commit graph with lane colors. AI actions live inline in a footer strip on the diff pane ("fix callers", "explain").
2. **Terminal with multiplexer** — session tab bar (named sessions, `^T` new, `⌥1-5` switch), a tiled grid of panes, `^S` split, `^Z` zoom, `^W` close. Panes are real PTYs. The mock shows four: a dev server, a Claude Code agent mid-task, a failing test watcher, and a release build. Pane output is bottom-anchored like a real terminal. Panes can hand off to other modules ("open in git ↑", "send to agent").
3. **Explorer** — terminal-like but clickable. Left tree, center column listing (name / size / modified / git status), right file preview with syntax highlighting. `/` find, `f` fuzzy jump, `⏎` open. A prompt line at the bottom takes natural-language operations on the selection ("rename diff.rs → diff_view.rs and fix imports").
4. **Agents** — queue of running/waiting/queued AI agents with status, token counts and elapsed time, plus a live transcript of the selected agent with inline approve/deny buttons for its questions.

Home-screen widgets: clock/date, to-do list, calculator, system stats (CPU/mem/net), recent projects with git status, scratchpad, an edge map, and an AI prompt bar as a floating pill at the bottom.

### Settings

A modal opened by a gear in the home header or the `,` hotkey. Four groups:
- **Edge assignment** — pick which module goes on each edge; assigning a module that already has an edge swaps the two.
- **Hotkeys** — full binding list, click to rebind.
- **Performance** — hardware acceleration (GPU compositing for the swap), panel blur, bounce on swap.
- **Modules** — installed modules with version and current edge, available modules, "+ add module" and "load from path…".

Changes apply live; config is written to `~/.config/suite/config.toml` on close.

### Visual direction

A compositor aesthetic: deep dark background with a soft radial tint, floating translucent panels (`rgba(17,23,32,.72)` with backdrop blur) separated by visible 14px gaps, 1px `#1f2937` borders, and a 2px accent border plus glow on the focused panel. Thin glowing rails at the four screen edges, one hue each. Everything is monospace (JetBrains Mono). Accent palette: teal `#4fd6be`, blue `#7aa2f7`, violet `#bb9af7`, amber `#e0af68`, green `#9ece6a`, red `#f7768e`. Aim for the feel of Charm's TUI tooling crossed with a tiling Wayland compositor — dense information, no decoration that isn't load-bearing.

### Architecture requirements

- Module contract: each module is a self-contained unit exposing `mount(container, ctx)`, `unmount()`, a keymap, and a status summary for the home screen. It gets no say in its own geometry.
- Module registry loads modules from a directory at startup and can add/remove them at runtime.
- Cross-module messaging bus so a terminal pane can send a file to git, or a test failure to an agent.
- Single animation module owning the spring curve; all four edges pull from it.
- The AI layer is a provider interface (Claude first) with streaming, tool use, per-module system prompts, and a token/cost meter.
- Boot path: display server → fullscreen surface → module registry → home. No window manager decoration.

### Step 0 — ask me about frameworks first

Before scaffolding, ask me to choose a stack. For each decision, give me the real options with an honest **good / bad** for each, then your recommendation and why. Do not pick for me. Cover at minimum:

1. **Shell runtime** — native (Rust + winit/wgpu, Zig, C++/Qt), web-in-native (Tauri, Electron, Wails), or true TUI (Ratatui, Bubble Tea) running on a bare TTY.
2. **UI layer** — GPU-drawn (wgpu, Skia), retained-mode toolkit (GTK4, Qt, Iced, egui), or DOM (Svelte, React, Solid, SolidStart) inside a webview.
3. **Terminal emulation** — embedding an existing emulator core (alacritty_terminal, wezterm-term, vte, xterm.js) vs writing PTY handling yourself; and multiplexing in-process vs shelling out to tmux/zellij.
4. **Git layer** — libgit2/gix bindings vs parsing the `git` CLI; and where hunk staging happens.
5. **Module system / hot-swap mechanism** — dynamic libraries, WASM components (wasmtime + WIT), a subprocess + IPC protocol, or JS bundles in a webview.
6. **State & config** — TOML/JSON on disk, SQLite, or an embedded KV store; and how live config changes propagate.
7. **Animation** — compositor-level transforms vs CSS transitions vs a hand-rolled spring integrator, and what that implies for the 440ms overshoot at 4K.
8. **AI integration** — direct Anthropic API, Claude Code as a subprocess, or an agent framework; and how streaming output lands in a pane.
9. **Platform target** — Linux/Wayland only, plus Windows/macOS, or cross-platform from day one; say plainly what each costs.
10. **Packaging & autostart** — how the thing actually launches at boot on my platform.

For each: 2–4 sentences of good, 2–4 of bad, then one line of "pick this if…". Flag anywhere my requirements (fullscreen at boot, hot-swap, real PTYs, GPU-smooth spring animation) make an option a bad fit.

### Then

Once I answer, propose the repo layout and the module contract as code before implementing anything, and build in this order: shell + edge navigation + spring animation → module contract + registry → terminal → git → explorer → agents → settings → boot integration.

### Things I care about

- Frame-perfect swap animation; it is the signature interaction.
- Keyboard-first. Mouse works, but nothing requires it.
- Density over decoration. Every panel earns its space; no empty boxes.
- Modules must be genuinely interchangeable across edges.
