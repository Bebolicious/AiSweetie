import { createEffect, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { render } from "solid-js/web";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import { Pane } from "./Pane";
import {
  closePane,
  focusAfterClose,
  layout,
  leaf,
  leaves,
  paneCount,
  splitAxis,
  splitPane,
  type Node,
  type PaneId,
} from "./panes";

import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

let seq = 0;
const nextPaneId = () => `pane-${++seq}`;

interface Session {
  name: string;
  tree: Node;
  focused: PaneId;
  /** When set, that pane fills the session and the others are hidden. */
  zoomed: PaneId | null;
}

function newSession(name: string): Session {
  const id = nextPaneId();
  return { name, tree: leaf(id), focused: id, zoomed: null };
}

function TerminalView(props: {
  register: (b: Binding[]) => void;
  report: (panes: number, sessions: number) => void;
  project: () => Project | null;
}) {
  const [sessions, setSessions] = createStore<Session[]>([newSession("shell")]);
  const [active, setActive] = createSignal(0);

  const current = () => sessions[active()];

  /** Measured, not assumed — the split axis depends on the real shape. */
  let grid: HTMLDivElement | undefined;

  const rects = () => {
    const s = current();
    const tree = s.zoomed ? leaf(s.zoomed) : s.tree;
    return layout(tree);
  };

  const visible = () => [...rects().keys()];

  // Keep the home screen's edge map honest without making it poll the tree.
  createEffect(() => props.report(paneCount(current().tree), sessions.length));

  const mutate = (fn: (s: Session) => void) =>
    setSessions(active(), produce(fn));

  const actions = {
    split() {
      const s = current();
      if (s.zoomed) return; // splitting a zoomed pane is ambiguous
      const rect = layout(s.tree).get(s.focused);
      if (!rect) return;
      const id = nextPaneId();
      const aspect = grid ? grid.clientWidth / grid.clientHeight : 16 / 9;
      mutate((sess) => {
        sess.tree = splitPane(
          sess.tree,
          sess.focused,
          splitAxis(rect, aspect),
          id,
        );
        sess.focused = id;
      });
    },

    zoom() {
      const s = current();
      if (paneCount(s.tree) < 2) return;
      mutate((sess) => {
        sess.zoomed = sess.zoomed ? null : sess.focused;
      });
    },

    close() {
      const s = current();
      const next = focusAfterClose(s.tree, s.focused);
      if (!next) {
        // Last pane in the session: close the session instead.
        if (sessions.length === 1) return;
        const i = active();
        setSessions((all) => all.filter((_, n) => n !== i));
        setActive(Math.max(0, i - 1));
        return;
      }
      mutate((sess) => {
        const tree = closePane(sess.tree, sess.focused);
        if (tree) sess.tree = tree;
        sess.focused = next;
        sess.zoomed = null;
      });
    },

    newSession() {
      setSessions(sessions.length, newSession(`shell ${sessions.length + 1}`));
      setActive(sessions.length - 1);
    },

    focus(id: PaneId) {
      mutate((sess) => {
        sess.focused = id;
      });
    },
  };

  props.register([
    {
      id: "terminal.split",
      keys: "mod+shift+s",
      label: "Split pane",
      run: actions.split,
    },
    {
      id: "terminal.zoom",
      keys: "mod+shift+z",
      label: "Zoom pane",
      run: actions.zoom,
    },
    {
      id: "terminal.close",
      keys: "mod+shift+w",
      label: "Close pane",
      run: actions.close,
    },
    {
      id: "terminal.new",
      keys: "mod+shift+t",
      label: "New terminal session",
      run: actions.newSession,
    },
    ...[1, 2, 3, 4, 5].map((n) => ({
      id: `terminal.session.${n}`,
      keys: `mod+${n}`,
      label: `Terminal session ${n}`,
      run: () => {
        if (sessions[n - 1]) setActive(n - 1);
      },
    })),
  ]);

  return (
    <div class="term">
      <div class="tabs">
        <For each={sessions}>
          {(s, i) => (
            <button
              type="button"
              class="tab"
              data-on={i() === active() ? "true" : "false"}
              onClick={() => setActive(i())}
            >
              <span class="tab__n">{i() + 1}</span>
              {s.name}
            </button>
          )}
        </For>
        <button type="button" class="tab tab--new" onClick={actions.newSession}>
          + new <span class="tab__key">⇧^T</span>
        </button>
        <span class="tabs__keys">
          ⇧^S split · ⇧^Z zoom · ⇧^W close · ^1-5 session
        </span>
      </div>

      <div class="grid" ref={grid}>
        <For each={leaves(current().tree)}>
          {(id) => (
            <Show when={rects().get(id)}>
              {(rect) => (
                <div
                  class="slot"
                  style={{
                    left: `${rect().left}%`,
                    top: `${rect().top}%`,
                    width: `${rect().width}%`,
                    height: `${rect().height}%`,
                  }}
                >
                  <div
                    class="pane"
                    data-focused={
                      id === current().focused && visible().includes(id)
                        ? "true"
                        : "false"
                    }
                  >
                    <div class="pane__head">
                      <span class="pane__dot">●</span>
                      <span class="pane__title">shell</span>
                      <span class="pane__id">{id}</span>
                      <Show when={current().zoomed === id}>
                        <span class="pane__badge">zoomed</span>
                      </Show>
                    </div>
                    <Pane
                      id={id}
                      cwd={props.project()?.path}
                      focused={id === current().focused}
                      onFocus={() => actions.focus(id)}
                      onExit={() => {}}
                    />
                  </div>
                </div>
              )}
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

export function terminalModule(): SuiteModule {
  let dispose: (() => void) | undefined;
  let bindings: Binding[] = [];
  let panes = 1;
  let sessionCount = 1;

  return {
    id: "terminal",
    title: "TERMINAL",
    version: "0.3.0",

    mount(container: HTMLElement, ctx: ModuleContext) {
      dispose = render(
        () => (
          <TerminalView
            register={(b) => {
              bindings = b;
            }}
            project={ctx.project}
            report={(p, s) => {
              panes = p;
              sessionCount = s;
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
      const p = `${panes} pane${panes === 1 ? "" : "s"}`;
      const s = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
      return {
        header: `${s} · ${p}`,
        home: p,
        tone: "active" as const,
      };
    },
  };
}
