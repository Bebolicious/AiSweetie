import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { render } from "solid-js/web";
import hljs from "highlight.js/lib/common";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import {
  fsx,
  fuzzyMatch,
  hasHost,
  humanSize,
  parentOf,
  relativeTime,
  type Entry,
} from "./api";
import { tailSegments } from "../../shell/paths";
import "highlight.js/styles/tokyo-night-dark.css";
import "./explorer.css";

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  css: "css",
  html: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  ps1: "powershell",
};

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

function ExplorerView(props: {
  register: (b: Binding[]) => void;
  report: (dir: string, count: number) => void;
  project: () => Project | null;
}) {
  const [dir, setDir] = createSignal<string>("");
  const [selected, setSelected] = createSignal<Entry | null>(null);
  const [filter, setFilter] = createSignal("");
  const [showHidden, setShowHidden] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  let filterInput: HTMLInputElement | undefined;

  // Follow the active project: a switch lands you at its root with the
  // previous project's filter, selection and tree state cleared.
  createEffect(
    on(
      () => props.project()?.path,
      (root) => {
        if (!root || !hasHost()) return;
        setDir(root);
        setFilter("");
        setSelected(null);
        setExpanded(new Set<string>());
      },
    ),
  );

  const [entries] = createResource(
    () => (dir() ? dir() : null),
    (d) => fsx.list(d),
  );

  const visible = createMemo(() => {
    const all = entries() ?? [];
    const q = filter();
    return all
      .filter((e) => showHidden() || !e.hidden)
      .filter((e) => fuzzyMatch(q, e.name));
  });

  createEffect(() => props.report(dir(), visible().length));

  // Keep a file selected so the preview pane is never pointlessly blank.
  createEffect(() => {
    const list = visible();
    const cur = selected();
    if (cur && list.some((e) => e.path === cur.path)) return;
    setSelected(list.find((e) => !e.dir) ?? null);
  });

  const [body] = createResource(
    () => selected()?.path ?? null,
    (p) => fsx.read(p),
  );

  const highlighted = createMemo(() => {
    const file = body();
    const sel = selected();
    if (!file?.textual || !sel) return null;
    const lang = LANG_BY_EXT[extOf(sel.name)];
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(file.text, { language: lang }).value
        : hljs.highlightAuto(file.text).value;
    } catch {
      return null;
    }
  });

  function open(entry: Entry) {
    if (entry.dir) {
      setDir(entry.path);
      setFilter("");
      setSelected(null);
    } else {
      setSelected(entry);
    }
  }

  function up() {
    const parent = parentOf(dir());
    if (parent) {
      setDir(parent);
      setFilter("");
    }
  }

  function toggleTree(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  props.register([
    {
      id: "explorer.find",
      keys: "/",
      label: "Filter listing",
      run: () => filterInput?.focus(),
    },
    {
      id: "explorer.fuzzy",
      keys: "f",
      label: "Fuzzy jump",
      run: () => filterInput?.focus(),
    },
    {
      id: "explorer.up",
      keys: "backspace",
      label: "Go to parent directory",
      run: up,
    },
    {
      id: "explorer.hidden",
      keys: ".",
      label: "Toggle hidden files",
      run: () => setShowHidden((v) => !v),
    },
  ]);

  return (
    <Switch>
      <Match when={!hasHost()}>
        <div class="panel empty-state">
          <div class="panel__label">EXPLORER</div>
          <p>Filesystem access needs the Tauri host. Run `npm run tauri dev`.</p>
        </div>
      </Match>

      <Match when={hasHost()}>
        <div class="exp">
          <aside class="panel exp-tree">
            <div class="panel__label">TREE</div>
            <div class="tree-root" title={dir()}>
              {tailSegments(dir(), 2)}
            </div>
            <For
              each={(entries() ?? []).filter(
                (e) => e.dir && (showHidden() || !e.hidden),
              )}
            >
              {(d) => (
                <div>
                  <button
                    type="button"
                    class="tnode"
                    onClick={() => toggleTree(d.path)}
                    onDblClick={() => open(d)}
                  >
                    <span class="tnode__caret">
                      {expanded().has(d.path) ? "▾" : "▸"}
                    </span>
                    {d.name}
                  </button>
                  <Show when={expanded().has(d.path)}>
                    <TreeChildren path={d.path} onOpen={open} />
                  </Show>
                </div>
              )}
            </For>
            <div class="keys">
              <span>/ find</span>
              <span>f fuzzy jump</span>
              {/* ⌫ (U+232B) is missing from JetBrains Mono and renders as
                  tofu — spell the key out instead. */}
              <span>bksp parent</span>
              <span>. hidden</span>
            </div>
          </aside>

          <section class="panel exp-list" data-focused="true">
            <div class="exp-list__head">
              <span>NAME</span>
              <span>SIZE</span>
              <span>MODIFIED</span>
            </div>

            <div class="exp-list__body">
              <Show when={parentOf(dir())}>
                <button type="button" class="row row--up" onClick={up}>
                  <span class="row__name">▸ ..</span>
                </button>
              </Show>
              <For
                each={visible()}
                fallback={<p class="muted pad">nothing here</p>}
              >
                {(e) => (
                  <button
                    type="button"
                    class="row"
                    data-on={selected()?.path === e.path ? "true" : "false"}
                    data-dim={e.hidden ? "true" : "false"}
                    onClick={() => setSelected(e.dir ? null : e)}
                    onDblClick={() => open(e)}
                  >
                    <span class="row__name">
                      <Show when={e.dir}>
                        <span class="row__caret">▸</span>
                      </Show>
                      {e.name}
                    </span>
                    <span class="row__size">
                      {e.dir
                        ? `${e.size} item${e.size === 1 ? "" : "s"}`
                        : humanSize(e.size)}
                    </span>
                    <span class="row__mod">{relativeTime(e.modified)}</span>
                  </button>
                )}
              </For>
            </div>

            <div class="exp-prompt">
              <span class="exp-prompt__caret">❯</span>
              <input
                ref={filterInput}
                class="exp-prompt__input"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder="filter this directory"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const first = visible()[0];
                    if (first) open(first);
                  }
                }}
              />
              <span class="exp-prompt__keys">{visible().length} shown</span>
            </div>
          </section>

          <aside class="panel exp-preview">
            <Show
              when={selected()}
              fallback={<p class="muted">select a file to preview</p>}
            >
              {(sel) => (
                <>
                  <div class="exp-preview__head">
                    <span class="bright">{sel().name}</span>
                    <span class="muted">
                      {LANG_BY_EXT[extOf(sel().name)] ?? "text"}
                      {body()?.textual ? ` · ${body()!.lines} lines` : ""}
                    </span>
                    <span class="exp-preview__size">
                      {humanSize(sel().size)}
                    </span>
                  </div>
                  <div class="exp-preview__body">
                    <Switch>
                      <Match when={body.loading}>
                        <p class="muted pad">reading…</p>
                      </Match>
                      <Match when={body() && !body()!.textual}>
                        <p class="muted pad">
                          binary or too large to preview ({humanSize(sel().size)})
                        </p>
                      </Match>
                      <Match when={highlighted()}>
                        <pre class="code hljs">
                          <code innerHTML={highlighted()!} />
                        </pre>
                      </Match>
                      <Match when={body()?.textual}>
                        <pre class="code">
                          <code>{body()!.text}</code>
                        </pre>
                      </Match>
                    </Switch>
                  </div>
                </>
              )}
            </Show>
          </aside>
        </div>
      </Match>
    </Switch>
  );
}

function TreeChildren(props: { path: string; onOpen: (e: Entry) => void }) {
  const [kids] = createResource(
    () => props.path,
    (p) => fsx.list(p),
  );
  return (
    <div class="tnode__kids">
      <For each={(kids() ?? []).filter((e) => e.dir && !e.hidden)}>
        {(d) => (
          <button type="button" class="tnode" onClick={() => props.onOpen(d)}>
            <span class="tnode__caret">▸</span>
            {d.name}
          </button>
        )}
      </For>
    </div>
  );
}

export function explorerModule(): SuiteModule {
  let dispose: (() => void) | undefined;
  let bindings: Binding[] = [];
  let where = "";
  let count = 0;

  return {
    id: "explorer",
    title: "EXPLORER",
    version: "0.2.0",

    mount(container: HTMLElement, ctx: ModuleContext) {
      dispose = render(
        () => (
          <ExplorerView
            register={(b) => (bindings = b)}
            project={ctx.project}
            report={(d, n) => {
              where = d;
              count = n;
            }}
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
      const leaf = where.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return {
        header: where ? tailSegments(where, 3) : "no directory",
        home: leaf ? `${leaf} · ${count} items` : "no directory",
        tone: "idle" as const,
      };
    },
  };
}
