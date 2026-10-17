import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createEffect,
  on,
} from "solid-js";
import { mountView } from "../../shell/mountView";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import { git, hasHost, type FileChange } from "./api";
import { hunkPatch, parseDiff, type Hunk } from "./diff";
import { splitPath } from "../../shell/paths";
import "./git.css";

type Selection = { path: string; staged: boolean } | null;

/** The three things that choose a diff, plus the manual-refresh counter. */
type DiffTarget = {
  repo: string;
  path: string;
  staged: boolean;
  tick: number;
} | null;

/**
 * Total diff lines below which every hunk renders expanded.
 *
 * Under this, nothing is bounded or hidden and the whole file is on screen at
 * once — the ordinary case. Over it, unfocused hunks collapse to their headers
 * and only the cursor's hunk shows its lines.
 */
const EXPAND_BUDGET = 800;

/**
 * Lines shown for one hunk before it asks to be opened further.
 *
 * Not a truncation. `space` stages the whole hunk — `hunkPatch` builds the
 * patch from the parsed diff, not from what is rendered — so a hunk that
 * silently showed you 600 of its 5000 lines meant staging 4400 lines you were
 * never given the chance to read. That is worse than a slow render.
 *
 * So anything beyond this is **reachable, not discarded**: the remainder is
 * one click away, and until it is opened the stage hint states the real line
 * count rather than implying the hunk is as short as it looks.
 */
const LINE_CAP = 600;

function statusHue(letter: string) {
  if (letter === "A" || letter === "M") return "var(--green)";
  if (letter === "D") return "var(--red)";
  if (letter === "?") return "var(--ink-faint)";
  return "var(--amber)";
}

function GitView(props: {
  register: (b: Binding[]) => void;
  report: (s: { branch: string; changed: number; repo: boolean }) => void;
  project: () => Project | null;
}) {
  // Keyed on the active project's path, so switching project re-resolves the
  // repository without a remount.
  const [repo, { refetch: refetchRepo }] = createResource(
    () => (hasHost() ? (props.project()?.path ?? null) : null),
    async (start) => {
      try {
        return await git.root(start);
      } catch {
        return null; // not a repository — a normal state, not an error
      }
    },
  );

  /**
   * What drives a refetch, and whether it should bypass the host's caches.
   *
   * Two different things call `reload`. Staging a hunk cannot move a ref, so
   * the cached branch list and log are still correct and asking for them again
   * is two wasted process spawns. Pressing `r` is the user saying the opposite
   * — so it carries `fresh`, and refresh means refresh.
   */
  const [reloadToken, setReloadToken] = createSignal({ n: 0, fresh: false });
  const reload = (fresh = false) =>
    setReloadToken((t) => ({ n: t.n + 1, fresh }));
  const tick = () => reloadToken().n;

  const key = () => {
    const r = repo();
    const t = reloadToken();
    return r ? ([r, t.n, t.fresh] as const) : null;
  };

  // Never cached: a worktree edit touches nothing a fingerprint can see, and
  // this is the one answer that must not be stale. See architecture §9.
  const [status] = createResource(key, ([r]) => git.status(r));
  const [branches] = createResource(key, ([r, , fresh]) =>
    git.branches(r, fresh),
  );
  const [log] = createResource(key, ([r, , fresh]) => git.log(r, 12, fresh));

  const [selected, setSelected] = createSignal<Selection>(null);
  const [hunkIndex, setHunkIndex] = createSignal(0);
  /** Hunk indices the user has asked to see in full, past `LINE_CAP`. */
  const [opened, setOpened] = createSignal<ReadonlySet<number>>(new Set());

  // A selection from the previous project means nothing in the next one.
  createEffect(
    on(
      () => props.project()?.id,
      () => {
        setSelected(null);
        setHunkIndex(0);
      },
      { defer: true },
    ),
  );

  // Pick the first changed file automatically so the diff pane is never blank
  // while there is something to look at.
  //
  // `equals` because this is read all over the render and returns a fresh
  // object every run, so without it every status poll invalidated every row in
  // the changed-files list to write back identical attributes.
  const autoSelect = createMemo<Selection>(
    () => {
      const s = status();
      if (!s) return null;
      const current = selected();
      if (current) {
        const still =
          (current.staged ? s.staged : s.unstaged).some(
            (f) => f.path === current.path,
          );
        if (still) return current;
      }
      const first = s.unstaged[0] ?? s.staged[0];
      return first
        ? { path: first.path, staged: !s.unstaged.includes(first) }
        : null;
    },
    null,
    { equals: (a, b) => a?.path === b?.path && a?.staged === b?.staged },
  );

  /**
   * Which diff to fetch, with an identity that only changes when the answer
   * does.
   *
   * This was a plain function returning a fresh array, fed straight to
   * `createResource`. A new array is a new value, so the resource refetched
   * whenever *anything* upstream moved rather than when the choice of diff
   * changed — measured at two `git_diff` calls per event where one was needed,
   * and `git_diff` is a ~12 ms process spawn.
   *
   * The `root` check is the other half, and it is why `RepoStatus.root` exists.
   * `status()` keeps serving the previous repository's data while it refetches,
   * so without it a project switch spends a spawn asking the new repo for a
   * diff of the old repo's file.
   */
  const diffTarget = createMemo<DiffTarget>(
    () => {
      const r = repo();
      const s = status();
      const sel = autoSelect();
      if (!r || !sel || s?.root !== r) return null;
      return { repo: r, path: sel.path, staged: sel.staged, tick: tick() };
    },
    null,
    {
      equals: (a, b) =>
        a?.repo === b?.repo &&
        a?.path === b?.path &&
        a?.staged === b?.staged &&
        a?.tick === b?.tick,
    },
  );

  const [diffText] = createResource(diffTarget, (t) =>
    git.diff(t.repo, t.path, t.staged),
  );

  const file = createMemo(() => {
    const raw = diffText();
    return raw ? parseDiff(raw) : null;
  });

  const hunks = () => file()?.hunks ?? [];
  const currentHunk = () => hunks()[hunkIndex()];

  /**
   * Whether every hunk shows its lines, or only the one under the cursor.
   *
   * Rendering every line of every hunk is unbounded, and the case that makes
   * it bite is ordinary: regenerate a lockfile and the diff is tens of
   * thousands of rows, each one three elements. Below the budget nothing
   * changes and you see the whole file at once, which is the common case.
   * Above it, hunks collapse to their headers and only the cursor's hunk is
   * open — which also makes `j`/`k` cheap, because moving the cursor then
   * re-renders two hunks instead of re-styling ten thousand rows.
   *
   * Keyed on the file rather than the cursor, so scrolling the cursor through
   * a large diff never flips the mode underneath you.
   */
  const expandAll = createMemo(
    () => hunks().reduce((n, h) => n + h.lines.length, 0) <= EXPAND_BUDGET,
  );

  // Hunk indices mean nothing once the diff changes underneath them.
  createEffect(on(file, () => setOpened(new Set<number>()), { defer: true }));

  const openFully = (i: number) =>
    setOpened((prev) => new Set(prev).add(i));

  createMemo(() => {
    const s = status();
    props.report({
      branch: s?.branch ?? "",
      changed: s ? s.staged.length + s.unstaged.length : 0,
      repo: !!repo(),
    });
  });

  async function toggleHunk() {
    const r = repo();
    const sel = autoSelect();
    const f = file();
    const h = currentHunk();
    if (!r || !sel || !f || !h) return;
    try {
      await git.applyPatch(r, hunkPatch(f, h), sel.staged);
      reload();
    } catch (err) {
      console.error("[git] hunk apply failed:", err);
    }
  }

  async function toggleFile() {
    const r = repo();
    const sel = autoSelect();
    if (!r || !sel) return;
    await git.stageFile(r, sel.path, sel.staged);
    reload();
  }

  props.register([
    {
      id: "git.nextHunk",
      keys: "j",
      label: "Next hunk",
      run: () => setHunkIndex((i) => Math.min(i + 1, hunks().length - 1)),
    },
    {
      id: "git.prevHunk",
      keys: "k",
      label: "Previous hunk",
      run: () => setHunkIndex((i) => Math.max(i - 1, 0)),
    },
    {
      id: "git.stageHunk",
      keys: "space",
      label: "Stage hunk under cursor",
      run: () => void toggleHunk(),
    },
    {
      id: "git.stageFile",
      keys: "a",
      label: "Stage whole file",
      run: () => void toggleFile(),
    },
    {
      id: "git.refresh",
      keys: "r",
      label: "Refresh repository",
      run: () => {
        void refetchRepo();
        reload(true);
      },
    },
  ]);

  const FileRow = (p: { f: FileChange; staged: boolean }) => (
    <button
      type="button"
      class="chg"
      data-on={
        autoSelect()?.path === p.f.path && autoSelect()?.staged === p.staged
          ? "true"
          : "false"
      }
      onClick={() => {
        setSelected({ path: p.f.path, staged: p.staged });
        setHunkIndex(0);
      }}
    >
      <span class="chg__st" style={{ color: statusHue(p.f.status) }}>
        {p.f.status}
      </span>
      <span class="chg__path" title={p.f.path}>
        <span class="chg__dir">{splitPath(p.f.path).dir}</span>
        <span class="chg__base">{splitPath(p.f.path).base}</span>
      </span>
      <span class="chg__n">
        <Show when={p.f.added > 0}>
          <span class="add">+{p.f.added}</span>
        </Show>
        <Show when={p.f.removed > 0}>
          <span class="del">−{p.f.removed}</span>
        </Show>
      </span>
    </button>
  );

  return (
    <Switch>
      <Match when={!hasHost()}>
        <div class="panel empty-state">
          <div class="panel__label">GIT</div>
          <p>Repository access needs the Tauri host. Run `npm run tauri dev`.</p>
        </div>
      </Match>

      <Match when={repo.state === "ready" && !repo()}>
        <div class="panel empty-state">
          <div class="panel__label">GIT</div>
          <p>
            No git repository at{" "}
            <code>{props.project()?.path ?? "the current project"}</code>. Pick
            another project from home (<code>o</code>), or run{" "}
            <code>git init</code> here to start one.
          </p>
        </div>
      </Match>

      <Match when={repo()}>
        <div class="git">
          <aside class="panel git-changes">
            <div class="panel__label">CHANGES</div>
            <Show
              when={status()}
              fallback={<p class="muted">reading repository…</p>}
            >
              {(s) => (
                <>
                  <div class="sect">STAGED · {s().staged.length}</div>
                  <For
                    each={s().staged}
                    fallback={<p class="muted">nothing staged</p>}
                  >
                    {(f) => <FileRow f={f} staged={true} />}
                  </For>

                  <div class="sect">UNSTAGED · {s().unstaged.length}</div>
                  <For
                    each={s().unstaged}
                    fallback={<p class="muted">working tree clean</p>}
                  >
                    {(f) => <FileRow f={f} staged={false} />}
                  </For>
                </>
              )}
            </Show>

            <div class="rule" />
            <div class="panel__label">BRANCHES</div>
            <For each={branches()}>
              {(b) => (
                <div class="branch">
                  <span class="branch__dot" data-on={b.current ? "true" : "false"}>
                    {b.current ? "●" : "○"}
                  </span>
                  <span classList={{ bright: b.current }}>{b.name}</span>
                  <span class="branch__age">{b.age}</span>
                </div>
              )}
            </For>

            <div class="keys">
              <span>␣ stage hunk</span>
              <span>a stage file</span>
              <span>j/k hunk</span>
              <span>r refresh</span>
            </div>
          </aside>

          <section class="panel git-diff" data-focused="true">
            <header class="git-diff__head">
              <span class="bright">{autoSelect()?.path ?? "no file selected"}</span>
              <Show when={hunks().length > 0}>
                <span class="muted">
                  hunk {hunkIndex() + 1} / {hunks().length}
                </span>
              </Show>
              <span class="git-diff__n">
                <span class="add">+{file()?.added ?? 0}</span>
                <span class="del">−{file()?.removed ?? 0}</span>
              </span>
            </header>

            <div class="git-diff__body">
              <Show
                when={hunks().length > 0}
                fallback={<p class="muted pad">no textual diff for this file</p>}
              >
                <For each={hunks()}>
                  {(h: Hunk, i) => {
                    const focused = () => i() === hunkIndex();
                    const open = () => expandAll() || focused();
                    const full = () => opened().has(i());
                    const shown = () =>
                      full() || h.lines.length <= LINE_CAP
                        ? h.lines
                        : h.lines.slice(0, LINE_CAP);
                    const hidden = () => h.lines.length - shown().length;

                    return (
                      <div class="hunk" data-on={focused() ? "true" : "false"}>
                        <div
                          class="hunk__head"
                          onClick={() => setHunkIndex(i())}
                        >
                          <span>{h.header}</span>
                          <span class="hunk__tag">
                            {autoSelect()?.staged ? "STAGED" : "UNSTAGED"}
                            {/* Name the real size when part of the hunk is
                                not on screen, so `space` is never a
                                surprise — it stages all of it either way. */}
                            <Show when={focused()}>
                              <Show
                                when={hidden() > 0}
                                fallback={<> ␣</>}
                              >
                                {" "}
                                ␣ stages all {h.lines.length} lines
                              </Show>
                            </Show>
                          </span>
                        </div>

                        <Show
                          when={open()}
                          fallback={
                            <div class="hunk__fold">
                              <span class="add">+{h.added}</span>{" "}
                              <span class="del">−{h.removed}</span> ·{" "}
                              {h.lines.length} lines — j/k or click to open
                            </div>
                          }
                        >
                          <For each={shown()}>
                            {(l) => (
                              <div class="dl" data-k={l.kind}>
                                <span class="dl__no">
                                  {l.newNo ?? l.oldNo ?? ""}
                                </span>
                                <span class="dl__t">
                                  {l.kind === "add"
                                    ? "+"
                                    : l.kind === "del"
                                      ? "−"
                                      : " "}
                                  {l.text}
                                </span>
                              </div>
                            )}
                          </For>
                          <Show when={hidden() > 0}>
                            <button
                              type="button"
                              class="hunk__more"
                              onClick={() => openFully(i())}
                            >
                              show the remaining {hidden()} lines of this hunk
                            </button>
                          </Show>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          </section>

          <aside class="panel git-graph">
            <div class="panel__label">GRAPH</div>
            <For each={log()} fallback={<p class="muted">no commits yet</p>}>
              {(c) => (
                <div class="commit">
                  <span class="commit__rail">│</span>
                  <span class="commit__dot">●</span>
                  <span class="commit__hash">{c.hash}</span>
                  <span class="commit__subject">{c.subject}</span>
                  <span class="commit__age">{c.age}</span>
                </div>
              )}
            </For>
          </aside>
        </div>
      </Match>
    </Switch>
  );
}

export function gitModule(): SuiteModule {
  let dispose: (() => void) | undefined;
  let bindings: Binding[] = [];
  let summary = { branch: "", changed: 0, repo: false };

  return {
    id: "git",
    title: "GIT",
    version: "0.2.0",

    mount(container: HTMLElement, ctx: ModuleContext) {
      dispose = mountView(
        () => (
          <GitView
            register={(b) => (bindings = b)}
            report={(s) => (summary = s)}
            project={ctx.project}
          />
        ),
        container,
      );
    },

    unmount() {
      dispose?.();
      dispose = undefined;
      bindings = [];
    },

    keymap() {
      return bindings;
    },

    status() {
      if (!summary.repo) {
        return { header: "no repository", home: "no repository", tone: "idle" as const };
      }
      const changed = `${summary.changed} changed`;
      return {
        header: `${summary.branch} · ${changed}`,
        home: `${summary.branch} · ${changed}`,
        tone: summary.changed > 0 ? ("attention" as const) : ("idle" as const),
      };
    },
  };
}
