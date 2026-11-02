# Devlog

Chronological record of work sessions: what changed, what was *decided*, and what the next session
needs to know. Newest first.

This is not a changelog (that is per-release and lists features) and not architecture
documentation ([`architecture.md`](architecture.md) owns the design, [`ROADMAP.md`](ROADMAP.md) owns
what is not built yet). It exists for one job: **a session that starts with no memory should be able
to read the top entry and resume.**

The rule: if a decision cost an argument, a measurement, or a mistake, it goes here. If it is
derivable from the code, it does not.

---

## How to resume

Paste this into a new session:

> Read `DEVLOG.md`, then `architecture.md` and `ROADMAP.md`. We are working through Phase 0 in
> order. 0.1 (config persistence) just landed; next is **0.2, the doctor layer**. Before writing any
> of it, note the open item at the top of the devlog — the app has never been run, so nothing from
> the last three sessions is verified at runtime.

Then pick one:

- **"Start 0.2."** The headline Phase 0 item. Design is in `architecture.md §11` and it is complete
  enough to implement from — `preflight()` on the module contract, a doctor panel rendered in place
  of a module body on a blocking check, platform-correct install commands, health dots on the home
  edge map. `probe.rs` and the richer `agent_available` already landed early, so start with the
  contract method and the panel, then the per-module checks.
- **"Smoke-test first."** Launch the app and walk the four checks under *Open* below. Ten minutes,
  and it closes out three sessions of unobserved work.
- **"Fix <item>."** Anything from *Known defects* below.

Useful context for whoever reads this cold:

- Tests: `npm test` (frontend, vitest) and `cargo test` in `src-tauri/`. Both must stay green.
- `cargo test -- --ignored --nocapture` runs the measurements rather than checks — they print
  distributions and timings. Use them instead of guessing; see *Lessons* below for why.
- `npm run dev` runs the whole frontend in a browser with every OS call stubbed. Fast loop for
  layout; nothing persists and all four modules show their "needs the Tauri host" state.

---

## Open: nothing is verified at runtime

**The app has not been launched once across the last three sessions.** Everything below is backed by
tests, typecheck, clippy and measurements — and none of that observes the real window. This is the
single cheapest high-value action available.

Four checks, in order of what they would catch:

1. **`exit` a shell in a terminal pane, then look for a surviving `conhost.exe`.** If it survives,
   PTY reaping does not work on Windows. Driving a real ConPTY from a test harness would not
   terminate — the child outlived `wait()` and the reader never saw EOF while the master was held —
   so this is an open question, not a verified fix.
2. **Type fast in a pane; paste a multi-line block.** Any transposed characters means the
   writer-thread rewrite is wrong about ordering.
3. **Open Settings, change an edge, close it, restart.** The 0.1 path end to end. Then hand-edit
   `config.toml`, relaunch, confirm it took. Then break it on purpose (delete a `]`) and confirm
   Settings reports it and refuses to overwrite.
4. **Open `node_modules` in the explorer**, and a renamed file in the git tab. Both were broken
   before; both should be fine now.

Unmeasurable from here and still unknown: swap frame timing, and cold start to first paint. Both
need the real window and devtools.

---

## Session 4 — Phase 0.1: config persistence

Branch `AISW-2-reinf-continuation-modules`. **134 frontend tests, 38 Rust, clippy and tsc clean.**

### Shipped

`src-tauri/src/config.rs` owns `config.toml`; `src/shell/config.ts` mirrors it. Each piece of shell
state owns its own mapping — `hydrateEdges`/`collectEdges`, `hydratePrefs`/`collectPrefs`,
`hydrateProjects`/`collectProjects` — so the schema translation sits beside the state it translates
rather than in one function that knows about everything.

Boot order is **registry → config → project**, and the order is load-bearing: `hydrateEdges`
validates stored module ids against the registry, so the registry must exist first; the config is
applied before the first render so configured edges are in place for frame one; and `bootProject` now
runs *only* if the config restored nothing.

### Decided

**A malformed config is never overwritten.** `architecture.md §14` says "changes apply live, the file
is written on Settings close" — and applied naively that destroys work. A typo fails the parse, the
app falls back to defaults, you close Settings, and your hand-edited file is replaced by defaults. So
a failed parse sets `read_only`, `save` refuses, and Settings shows why. This is the most important
test in `config.rs`.

**`deny_unknown_fields`.** A misspelled key is a reported error rather than a setting that
mysteriously does nothing.

**Unmanaged blocks are carried forward.** A save rewrites `[edges]`, `[performance]` and
`[[projects]]` and copies the rest from what was read — otherwise this build, which has not
implemented hotkey rebinding (0.9), would wipe `[hotkeys]` every time you opened Settings.

**`[fleet]` reserved ahead of the feature.** A Managed Agent is created once and referenced by id
forever, so losing the id orphans it. Free to reserve now, a migration to add later.

**Config path uses an empty qualifier/organization.** The conventional
`ProjectDirs::from("com", "aisweete", "suite")` puts Windows at
`%APPDATA%\aisweete\suite\config\config.toml` — four levels deep with "config" twice, for a file a
human is meant to open. Empty strings give `%APPDATA%\suite\config\` and leave Linux at exactly
`$XDG_CONFIG_HOME/suite/config.toml` per the original brief. **Measured, not assumed** — the doc had
previously claimed `%APPDATA%\com.aisweete.suite\`, which was wrong.

### Found the hard way

**A tautology hid a real bug.** One test assertion read
`expect(...).toBe("terminal" === "terminal" ? "terminal" : "")` — it asserted nothing. Replacing it
with a real check failed immediately: `hydrateEdges({ top: "terminal" })` left **terminal on two
edges and git on none**. The dedup pass "reset" a collision to `DEFAULT[edge]`, but `right`'s default
*is* terminal, so the reset put the collision straight back. Rewritten as claim-then-fill-from-
remainder. Would have shipped as "I edited one line of config and now an edge is blank" — the same
symptom as the HMR gap in §7, which is miserable to debug from the symptom.

**Config tests needed `--test-threads=1`** because six of them shared the `SUITE_CONFIG` env var. A
suite that only passes with a special flag is a trap, so `load`/`save` now take the path as a
parameter and resolve the env var only at the command boundary. Better design, and they parallelise.

### Also decided this session (fleet architecture, deferred)

The agents module will become a **coordinator + worker roster on Managed Agents with a self-hosted
sandbox** — full reasoning in `architecture.md §13`, entry in `ROADMAP.md` after Phase 0. Three
things to remember about it:

- **Self-hosted is the critical setting.** By default Managed Agents runs tools in an
  Anthropic-hosted container, which is wrong here — the point is agents working on *your* checkout.
  `config: {type: "self_hosted"}` keeps orchestration remote and tool execution local.
- It needs an **API key** (unlike the CLI subprocess path) plus `ANTHROPIC_ENVIRONMENT_KEY`.
- It is deliberately after Phase 0: it wants 0.1 for the ids, and 0.7 for a coordinator's output to
  land anywhere.

Deliberately **not** started. Phase 0 in order was the explicit choice.

---

## Session 3 — measurement

Replaced estimates with numbers. Four `#[ignore]`-d measurements now live beside the code they
measure; `cargo test -- --ignored --nocapture`. (Session 4 added a fifth ignored test, which prints
the resolved config path rather than a timing.) (A fifth ignored test, added in session 4, prints the
resolved config path.)

| What | Result |
|---|---|
| PTY batch sizes | 2 MB of build output → 9602 reads, **33 messages**, p50 64 KB, **0 % of bytes on the slow `eval` path** |
| `fs_list` child counting | 4.6 ms → 0.2 ms on this repo's `node_modules` (87 subdirectories) |
| …and how it scales | ~50 µs per subdirectory: one frame at ~330, 100 ms at 2000 |
| `git_status` | **101 ms → 32.7 ms** after the fix below |
| Diff render size | 5000-line diff: 5000 rows → 100 (many hunks) or 600 (one hunk) |

**`git_status`: 6 sequential calls → 3 overlapping.** `status --porcelain=v2 --branch` answers the
branch, ahead/behind and changed files in one invocation where v1 needed three; `rev-parse
--show-toplevel` went entirely (the caller already holds the root). The remaining three start before
any is collected. Both halves paid off separately — 101 → 57 ms from fewer processes, 57 → 32.7 ms
from overlapping. At 32.7 ms for three calls against 11.9 ms for one, **three serial
`CreateProcess` calls is now the floor**; lower means dropping the ± column.

`--no-optional-locks` on every git call is load-bearing once they overlap: `git status` otherwise
rewrites the index stat cache and collides with the concurrent diffs.

**Caching, with a stated criterion.** *Staleness has to be detectable more cheaply than the work.*

| | cached? | why |
|---|---|---|
| `git_status` | **no** | a worktree edit touches nothing detectable; a cache would lie |
| `git_branches` / `git_log` | yes | refs fingerprint — `HEAD` + loose refs + `packed-refs` stat |
| `fs_read` + highlight | yes | revalidated per use against mtime, one `stat` |
| `git_diff` | no | changes with the worktree, same as status |

`git_diff` was also running **twice per event** — `autoSelect` returned a fresh object and the
resource key a fresh array, so `createResource` never found them equal. One per event now.

### Lessons

**I was accurate about mechanisms and wrong about magnitudes, in both directions.** I called
`fs_list` a "multi-second hard freeze"; it was 4.6 ms. I called the PTY channel the change most
likely to need reverting; it turned out the best-validated one. The pattern was that the magnitude
always flattered whatever story I was telling. Hence the committed measurements — the thresholds are
now tunable against evidence rather than intuition about frame budgets.

**A test that passes either way proves nothing.** Every behavioural fix this session and last was
checked by breaking it again and confirming the test failed. Two caught nothing until that check:
the explorer cache test (it was measuring the mock's short-circuit, not the cache) and the edges
tautology above.

---

## Session 2 — correctness and containment

**Error containment.** A module calls `render()` inside its own `mount()`, which creates a separate
reactive root — so an `ErrorBoundary` in `ModuleFrame` cannot see anything it throws. `mountView` in
`src/shell/` is a drop-in replacement for `render` that puts the boundary *inside* the module's root.
A module that throws now loses its own cell and nothing else. This is why **rule 11** exists in
§18: a module author who calls `render` directly silently loses containment.

**Two listener leaks, one invariant.** `listen()` resolves asynchronously, so an unmount before it
settles leaves the listener registered forever. Both the agents module and `Pane.tsx` had it — and
`Pane.tsx` was the one I had pointed at as the correct pattern, which it was not. Written down once
in `shell/disposers.ts`: a disposer that arrives after disposal is disposed immediately.

**PTY reaping.** A shell exited with `exit` left its `Session` in the map forever, holding a zombie
child. The reader thread now reaps on EOF — which also ends the writer thread, since dropping the
session drops the last sender. **Unverified on Windows; see *Open* above.**

**Git `-z` parsing.** Default `--porcelain` prints a rename as `R "old" -> "new"` on one line, so the
path became a string matching no file: staging failed *and* `git diff` on it failed. `-z` throughout.
Verified empirically against a real repo before changing anything, and the new tests fail against the
old parser.

**Visibility gating.** No blur while the world is in flight or in off-view cells (a
`backdrop-filter` costs the same at any radius, so these say `none`); `useStatus` compares fields
before writing and skips polling entirely while `moving()`; the clock ticks on the minute, not the
second. All of this remains **unvalidated** — it needs the real window.

---

## Session 1 — the main-thread audit

All 20 Rust commands were declared `pub fn`, which Tauri runs on the **main thread** — the one
pumping the window's message loop. `git_status` was six sequential process spawns on it; `fs_list`
did a `read_dir` per subdirectory. Every command that touches the OS is now `async` over a
synchronous `pub(crate)` function via `src-tauri/src/task.rs`.

**`pty_write` and `pty_resize` stayed synchronous, deliberately.** `pty_write` is called once per
keypress; running sync on the main thread is what *orders* keystrokes. Moving it to the blocking pool
would have let `ls` arrive as `sl`. But it was genuinely blocking, so each pane got a dedicated
writer thread fed by an `mpsc` channel — order-preserving by construction, never blocks. Both carry
doc comments saying so, because "deliberately not async" is the kind of thing a future reader
"fixes".

**PTY output path rebuilt.** `app.emit` is a broadcast: every pane received every other pane's bytes
and discarded them in JS. Now a per-pane `Channel` carrying raw bytes, coalesced over 3 ms — and the
coalescing is what makes it pay, because Tauri sends a raw payload under 1 KB as an `eval`'d JSON
number array, which is *worse* than the base64 it replaced.

---

## Standing decisions

Things that keep coming up. Changing any of these is a decision, not a cleanup.

- **Docs are the source of truth.** `architecture.md` for design and *why*, `ROADMAP.md` for what is
  not built. If code and doc disagree, one of them is a bug — fix the right one.
- **Phase 0 before Phase 1.** The gate's argument: a suite that teaches you not to trust it is worth
  less than four modules that always work.
- **Measure before claiming a magnitude.** See session 3.
- **Break the test to prove it works.** A test that passes against the broken version is noise.
- **`status()` is synchronous and cheap**, because home polls all four modules.
- **Edge hues follow direction, never module.** Swapping modules between edges must not move the
  colour — it is spatial memory, not decoration.
- **Secrets never land in `config.toml`.**
- **The docs had no place for "this is built and wrong"** until session 3 added one. Defects in
  shipped code go in the second table in `architecture.md §17`; absent features go in
  `ROADMAP.md`.

---

## Known defects

Shipped code that is wrong, as opposed to features that are absent. The full list with file
references is the second table in `architecture.md §17`. The ones worth doing soon:

| | Where |
|---|---|
| `git_diff_untracked` exists but nothing calls it — a new file shows "no textual diff" and `space` does nothing, despite §9 describing it as working | `modules/git/index.tsx` |
| A hunk over 600 lines renders truncated; `space` stages all of it. The remainder is reachable and the hint states the real count, but staging still exceeds what is on screen | `modules/git/index.tsx` |
| The explorer listing has no keyboard navigation at all, in a keyboard-first app — moving the selection needs the mouse | `modules/explorer/index.tsx` |
| `useStatus` runs nine independent 1 s timers; one shared ticker would do | `shell/useStatus.ts` |
| No `[profile.release]` — no LTO, `codegen-units`, or `strip`. Flagged three times, never done | `src-tauri/Cargo.toml` |
| `Settings.tsx` hardcodes `suite 0.1.0` rather than reading the real version | `shell/Settings.tsx` (0.11) |
| No `LICENSE` file, though `package.json` says MIT | — |
| 604 KB of JS parses on every cold boot, unmeasured. The xterm WebGL addon is dead weight until the first pane mounts | — |
