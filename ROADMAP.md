# Roadmap

How this app gets from "four working modules" to "the only program I open all day."

Read [`architecture.md`](architecture.md) first — it explains the system this roadmap extends, and
§11, §12 and §13 there carry the full designs for the three largest Phase 0 items.

## The gate

**Phase 0 must be complete before anything in Phase 1 starts.** Not "mostly complete."

The reason is specific: this app's value proposition is that you never have to leave it. A suite with
eight modules where two of them silently fail on a fresh machine is worth less than a suite with four
that always work, because the first one teaches you not to trust it. New modules are the fun work;
they are also the work that is worthless if the foundation leaks.

Phase 0 is the v1 release. When it ships, the app is handed to testers.

---

## Phase 0 — v1 release readiness

Ordered by dependency, not by size. 0.1 and 0.2 unblock most of what follows.

### 0.1 — Config persistence

Read `config.toml` at boot, write it on Settings close. `edges.ts` and `prefs.ts` hydrate from it
instead of hardcoded defaults. Schema and path rules in architecture §14.

First because every item below wants to persist something, and a second persistence mechanism added
later is a migration.

**Done when:** edge assignment and the three performance toggles survive a restart, and hand-editing
the TOML is reflected on next launch.

### 0.2 — The doctor layer

`preflight()` on the module contract, a doctor panel rendered in place of a module body on a blocking
check, platform-correct install guidance, and health dots on the home edge map. Full design and the
per-module check list in architecture §11.

This is the headline requirement: the app is going to strangers' machines.

**Partly done.** `src-tauri/src/probe.rs` (binary resolution, including the login-shell fallback that
finds nvm/asdf installs a graphical session can't see) and the richer `agent_available` →
`ClaudeStatus` both landed early, because they were what stood between a fresh Linux clone and a
working agents tab. Remaining: the contract method, the panel, install guidance, health dots, and the
same treatment for git, terminal and explorer.

**Done when:** a machine with no `git`, no `claude` CLI and no API key opens all four tabs and each one
explains what is missing and offers a fix that works on that OS. Verify by renaming the binaries on a
VM, not by mocking.

### 0.3 — `registry.reload(id)`

Unmount → re-import with a cache-busting query → re-register → remount. The dev build hooks
`import.meta.hot.accept` into it. Also unblocks Settings' "load from path…", which additionally needs
a Rust custom protocol to serve bundles off disk.

Fixes the HMR registry gap documented in architecture §7 — currently the most confusing thing about
developing on this codebase — and it is the mechanism self-dev mode depends on.

**Done when:** editing a module's source updates it live; no restart, no blank body, no stale header.

### 0.4 — Projects

A `Project` list, an `activeProject` signal added to `ModuleContext`, persisted to config, with the
home "recent projects" widget as the switcher. All four modules scope to it. Terminal sessions are
kept per-project. Design and rationale in architecture §12.

Has to be shell-level: `fs_cwd` resolves one directory for the whole app. The groundwork exists —
`fsx.rs` already honors `SUITE_PROJECT`.

**Mostly done, and landed ahead of 0.2 and 0.3.** It went early because swapping projects turned out
to be a daily need, and because 0.2's "active project is a repo" / "pick a folder" checks need a
notion of active project to exist first. `src/shell/project.ts` holds the signal and recents; the
home Projects panel (`o`, or the chip) is the switcher — an in-app path input with Tab completion
rather than the OS folder dialog, which is a foreign mouse-first window over a fullscreen app. Git,
explorer and agents re-scope on switch; terminal panes spawned after a switch start in the new
project while running panes keep theirs.

Deliberately **not** persisted: the active project and recents reset on restart, exactly like edges
and prefs do today. They hydrate from `[[projects]]` in config.toml when 0.1 lands, which is why no
localStorage or second mechanism was added. Still open: per-project terminal session restore.

**Done when:** switching project re-scopes git, explorer, terminal and agents without a restart, live
PTYs survive the switch, and two repos can be worked in one session. ✔ — plus, after 0.1, the
active project survives a restart.

### 0.5 — Self-dev mode

A project flagged `selfDev` pointing at this repo: agent write-tools enabled for it (the only place the
read-only default is lifted, and visibly opt-in), file-watch wired to `registry.reload()`, and a
terminal session preset on `npm run tauri dev`.

**Done when:** you can edit a module, watch it reload, review the diff, commit and push — without
leaving the app. Shell and Rust edits still need a restart; that boundary is documented, not hidden.

### 0.6 — AI provider layer

Anthropic API from Rust with SSE streaming, per-module system prompts, and one token/cost meter every
call passes through. Architecture §13 explains why this is Rust-side and why it coexists with the
Claude Code subprocess rather than replacing it.

Unblocks four features the mock advertises and the code does not have: the AI commit message, the diff
footer (`fix callers` / `explain`), the explorer's natural-language prompt, and the home prompt pill.

**Done when:** all four work, each reports its token count, and the home meter shows a day's spend
that matches the API console.

### 0.7 — Bus wiring

The handoffs the mock advertises and nothing currently implements: `open in git ↑`, `send to agent`,
`stage in git ↑`. The bus and its typed event union already exist (architecture §6); no module uses
them.

Small, but it is the thing that makes four modules feel like one app instead of four tabs.

**Done when:** each handoff navigates to the target module with the payload landed and focused.

### 0.8 — Home completion

Todo, calculator, system stats (CPU/mem/net), scratchpad, hotkey chips. Clock, projects (with git
status on the active one), edge map and prompt pill already ship.

Deliberately late: the widgets want real data from the layers above. Shipping them earlier would mean
shipping the placeholder boxes that `src/home/home.css:1` refuses.

**Done when:** home matches `ui-mock/home.png` — gitignored, so this is a check against a local
reference rather than anything in the repository — with every widget backed by real data, and the
system stats cost nothing measurable on the swap.

### 0.9 — Settings for real

Hotkey rebinding writes to config and takes effect live (currently display-only). The module list
reflects the registry rather than static text. "Load from path…" works. Add the `mod+k` command palette
the mock's chips advertise, sourced from `router.all()` — every binding is already declarative, so the
palette is nearly free once rebinding exists.

**Done when:** rebinding a key persists across restart and the palette can run any declared binding.

### 0.10 — Packaging

Narrow `bundle.targets` per platform. Windows: NSIS + MSI + portable `.exe`, with the WebView2
bootstrapper choice made deliberately. Linux: AppImage + `.deb`, with a `webkit2gtk-4.1` doctor check.
Autostart opt-in in Settings. Details in architecture §15.

**Done when:** a tester on clean Windows and clean Ubuntu installs, launches, and the doctor layer walks
them through whatever their machine is missing — with no terminal involved.

### 0.11 — Release hygiene

CHANGELOG, and a single source of truth for the version. `package.json`,
`Cargo.toml`, `tauri.conf.json` and `Settings.tsx:75` all say `0.1.0` today, but the last one is a
hardcoded string — it should read the real version rather than agreeing by coincidence. Module
versions stay independent of the shell's (git 0.2.0, terminal 0.3.0, explorer 0.2.0, agents 0.2.0);
that is by design, since a module is a separately versioned unit. CI running `npm test`, `cargo test`,
and both platform builds. Tighten `csp` from `null` as far as the current module loader allows.

`README.md` ships already, with an ASCII diagram of the 3×3 world standing in for images. Replace
that with **real captures** here, not before: `docs/home.png`, one per module, and `docs/swap.gif`
of the 440ms slide. Deliberately last, because screenshots taken now would advertise a home screen
that 0.8 has not built yet — the mock's PNGs stay out of the repo for the same reason. Captures of
the real app, not `ui-mock/`.

**Done when:** tagged `v1.0.0` with installers attached to the GitHub release.

---

## Phase 1 — day-one dev essentials

Four modules that cover the common reasons a developer would otherwise have to leave the app. Each
follows the contract in architecture §6 and ships with `preflight()` from day one — the doctor layer
exists by now, and a new module that ignores it is a regression.

**Docker / containers** — container and compose list, logs, exec into a shell, image sizes and prune.
First in the phase because "is my database up" is the most frequent reason to alt-tab out. Preflight is
interesting here: the daemon can be absent, present-but-stopped, or present-but-permission-denied, and
those are three different fixes.

**Database client** — connect, browse schema, run queries, results grid. Scoped to the active project's
connection string. Starts with Postgres and SQLite; the grid is the reusable part.

**System monitor** — process list, CPU/mem/net/disk. The real version of the home stats widget, which
should become a compact view of this module's data rather than a second implementation.

**Notes** — persistent markdown, project-scoped. The home scratchpad promoted to a full module, with
the widget becoming a window onto it. Also the natural storage substrate for Phase 2.

---

## Phase 2 — the AI diary

The feature that makes the app feel like it remembers your week rather than starting fresh every
morning.

On the **first launch of each day**, the home hub surfaces a summary of what you have done so far this
week. The module reads activity across a Monday→Sunday window and maintains **exactly one** markdown
file at a time. On the first launch of a **new week**, it asks whether to keep last week's diary or
start fresh.

It lands after Phase 1 because the quality of the summary depends entirely on how much the app can
observe. With Docker, DB and notes modules present, "what I did this week" is a real answer; with four
modules it is a list of commits you could get from `git log`.

Design questions to settle when it starts, deliberately left open:

- **Activity sources** — commits, agent transcripts, terminal history, notes, file churn. Each has a
  different signal-to-noise ratio and terminal history in particular is mostly noise.
- **Summarization** — the provider layer from 0.6, run once per day at first launch and cached. Cost
  must land on the same meter as everything else.
- **The retention prompt** — exact wording and default. A prompt that appears once a week and is easy
  to answer wrong will lose someone's week.
- **Storage** — where the file lives relative to `config.toml`, whether it is per-project or global
  (probably global; a week spans projects), and whether old diaries are really discarded or archived.
- **Privacy** — this file is a record of your work. It must never be sent anywhere except the
  summarization call, and that must be visible.

---

## Phase 3 — considered modules

Not committed. A module is promoted out of this list when it actually blocks a work day — the test is
"I had to leave the app to do this," not "this would be neat."

HTTP / API client · kanban tasks · log viewer and tailer · SSH and remote hosts · Kubernetes ·
clipboard history · snippets · project-wide search and replace · calendar · email · CI and build
dashboard · issue tracker · diff and merge tool · REPL scratchpads · dependency and vulnerability
auditing.

---

## Phase 4 — platform and ecosystem

Turning "modules I wrote" into "modules anyone can write."

**Third-party modules** — a manifest format, a signed or at least versioned distribution story, and
**isolation**: sandboxed iframes so a bad module cannot take down the shell. The current in-process ES
module approach accepts that risk explicitly (architecture §2) on the grounds that we are the only
author; that stops being true here. Requires tightening `csp` from `null`.

**The open bus channel** — added alongside the closed `BusEvents` union, not replacing it. Built-in
modules keep full type safety; third parties get a namespaced, runtime-validated channel.

**Module discovery** — a browsable index and an install flow in Settings, built on the "load from path…"
machinery from 0.3.

**macOS** — needs a Mac to build and an Apple developer account to notarize.

**Theming** — the design currently commits to a single dark palette (architecture §5). Supporting more
means deciding whether edge hues stay fixed, and they probably should: they encode *direction*, which
is spatial memory, not taste.
