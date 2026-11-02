import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { mountView } from "../../shell/mountView";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import {
  fsx,
  fuzzyMatch,
  hasHost,
  humanSize,
  parentOf,
  relativeTime,
  type Entry,
  type FileBody,
} from "./api";
import { debounced } from "../../shell/debounce";
import { createLru } from "../../shell/lru";
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

/**
 * Exactly the grammars `LANG_BY_EXT` names, registered against
 * highlight.js/lib/core.
 *
 * Not `lib/common`, which carries about forty languages and was the single
 * largest thing in the bundle. Adding an extension above means adding its
 * import here — which is the point: the cost of a language is visible.
 */
for (const [name, lang] of Object.entries({
  bash,
  css,
  go,
  ini,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}

/**
 * Above this, highlighting costs more than it is worth.
 *
 * `fs_read` already refuses to read past 512 KB, but reading is the cheap
 * half — highlighting a file that size is long enough to drop frames, and a
 * file that large is usually minified or generated and unreadable anyway.
 */
const HIGHLIGHT_LIMIT = 128 * 1024;

/**
 * How many rendered previews to keep.
 *
 * A count rather than a byte budget because `HIGHLIGHT_LIMIT` already bounds
 * each entry: nothing larger than 128 KB is highlighted, so the worst case is
 * eight files' text plus their markup, not "however big the files were".
 */
const PREVIEW_CACHE = 8;

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** A preview, after both the parts that cost something. */
interface Rendered {
  body: FileBody;
  /** The mtime this was read at, used to revalidate it. */
  modified: number;
  /** Highlighted markup, or null when the file renders as plain text. */
  html: string | null;
}

/**
 * Highlight a file, or decline to.
 *
 * There is deliberately no `highlightAuto` fallback. It runs every registered
 * grammar over the text and scores them, so an unrecognised extension —
 * `.lock`, `.txt`, `.cfg`, no extension at all — paid for every language at
 * once, synchronously on the main thread. Returning null renders plain text,
 * which the preview's `Switch` already falls through to.
 */
function highlightOf(name: string, body: FileBody): string | null {
  if (!body.textual || body.bytes > HIGHLIGHT_LIMIT) return null;

  const lang = LANG_BY_EXT[extOf(name)];
  if (!lang || !hljs.getLanguage(lang)) return null;

  try {
    return hljs.highlight(body.text, { language: lang }).value;
  } catch {
    return null;
  }
}

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

  /**
   * Keep a file selected so the preview pane is never pointlessly blank.
   *
   * Keyed on the directory listing, **not** on the filtered view. Keying it on
   * `visible()` meant that filtering something out from under the selection
   * re-pointed it at the first remaining match — so every keystroke in the
   * filter could change the selection, and every selection change is an IPC
   * file read plus a synchronous whole-file highlight. Typing `comp` ran that
   * four times for three results nobody asked to see.
   *
   * It also read badly: the preview flickered through unrelated files while
   * you typed. Filtering now only filters. `Enter` opens the top match, which
   * is the affordance that was already there for choosing one.
   */
  createEffect(() => {
    const all = entries() ?? [];
    const cur = selected();
    if (cur && all.some((e) => e.path === cur.path)) return;
    setSelected(all.find((e) => !e.dir) ?? null);
  });

  /**
   * What the preview pane is showing, which lags the selection on purpose.
   *
   * The listing's row highlight follows `selected()` instantly; only the
   * expensive half — the read and the syntax highlight — waits for this. So
   * clicking quickly down a listing costs one read rather than one per row,
   * without the selection ever feeling delayed.
   *
   * The whole entry is debounced rather than just its path, so everything the
   * pane renders comes from the same instant. Debouncing only the path would
   * leave the language and the file name a step ahead of the text, and
   * `highlighted()` would run the new grammar over the old content — wrong on
   * screen, and a wasted highlight before the right one.
   */
  const preview = debounced(selected, 120);

  /**
   * Reading and highlighting a file, cached.
   *
   * Both halves are cached together because the read is the cheap one — it is
   * off the main thread entirely (see `task` on the Rust side) — while the
   * highlight is synchronous JavaScript over the whole file. Caching the read
   * alone would leave the part that actually drops frames.
   *
   * **Every hit is revalidated.** The cached mtime goes back to the host as
   * `known`, and the hit is honoured only if the file still has that mtime.
   * What is saved is the read, an IPC payload of up to 512 KB, and the
   * highlight; what it costs is one `stat`.
   *
   * It is tempting to validate against the mtime `fs_list` already reported
   * and skip the IPC altogether, which is what this first did. That is
   * unsound: a listing is a snapshot, nothing re-lists a directory you are
   * already looking at, so a file edited in a terminal pane would be served
   * from here for as long as you stayed put. Showing stale file contents to
   * save a `stat` is the same bargain refused for `git_status`.
   */
  const previews = createLru<Rendered>(PREVIEW_CACHE);
  // Rule 7: a module releases what it holds. The cache is per mount rather
  // than module-level so a reload does not keep a disposed module's files.
  onCleanup(() => previews.clear());

  const [rendered] = createResource(preview, async (entry) => {
    const hit = previews.get(entry.path);
    const body = await fsx.read(entry.path, hit?.modified);

    // `unchanged` means the host stopped after `metadata` and read nothing.
    if (body.unchanged && hit) return hit;

    return previews.set(entry.path, {
      body,
      modified: body.modified,
      html: highlightOf(entry.name, body),
    });
  });

  const body = () => rendered()?.body;
  const highlighted = () => rendered()?.html ?? null;

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
                    {/* No child count for directories: producing it cost a
                        read_dir per row. See `list` in src-tauri/src/fsx.rs. */}
                    <span class="row__size">
                      {e.dir ? "—" : humanSize(e.size)}
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
              when={preview()}
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
                      <Match when={rendered.loading}>
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
      dispose = mountView(
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
