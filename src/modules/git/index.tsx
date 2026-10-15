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
import { render } from "solid-js/web";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import { git, hasHost, type FileChange } from "./api";
import { hunkPatch, parseDiff, type Hunk } from "./diff";
import { splitPath } from "../../shell/paths";
import "./git.css";

type Selection = { path: string; staged: boolean } | null;

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

  const [tick, setTick] = createSignal(0);
  const reload = () => setTick((n) => n + 1);

  const key = () => {
    const r = repo();
    return r ? ([r, tick()] as const) : null;
  };

  const [status] = createResource(key, ([r]) => git.status(r));
  const [branches] = createResource(key, ([r]) => git.branches(r));
  const [log] = createResource(key, ([r]) => git.log(r, 12));

  const [selected, setSelected] = createSignal<Selection>(null);
  const [hunkIndex, setHunkIndex] = createSignal(0);

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
  const autoSelect = createMemo(() => {
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
  });

  const diffKey = () => {
    const r = repo();
    const sel = autoSelect();
    return r && sel ? ([r, sel.path, sel.staged, tick()] as const) : null;
  };

  const [diffText] = createResource(diffKey, ([r, path, staged]) =>
    git.diff(r, path, staged),
  );

  const file = createMemo(() => {
    const raw = diffText();
    return raw ? parseDiff(raw) : null;
  });

  const hunks = () => file()?.hunks ?? [];
  const currentHunk = () => hunks()[hunkIndex()];

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
        reload();
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
                  {(h: Hunk, i) => (
                    <div class="hunk" data-on={i() === hunkIndex() ? "true" : "false"}>
                      <div
                        class="hunk__head"
                        onClick={() => setHunkIndex(i())}
                      >
                        <span>{h.header}</span>
                        <span class="hunk__tag">
                          {autoSelect()?.staged ? "STAGED" : "UNSTAGED"}
                          <Show when={i() === hunkIndex()}> ␣</Show>
                        </span>
                      </div>
                      <For each={h.lines}>
                        {(l) => (
                          <div class="dl" data-k={l.kind}>
                            <span class="dl__no">{l.newNo ?? l.oldNo ?? ""}</span>
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
                    </div>
                  )}
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
      dispose = render(
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
