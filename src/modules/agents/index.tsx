import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { mountView } from "../../shell/mountView";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Binding, ModuleContext, Project, SuiteModule } from "@suite/module";
import { createDisposers } from "../../shell/disposers";
import { focus as shellFocus } from "../../shell/focus";
import {
  formatElapsed,
  formatTokens,
  parseAgentLine,
  type Item,
} from "./stream";
import "./agents.css";

const hasHost = () => "__TAURI_INTERNALS__" in window;

type State = "running" | "done" | "failed";

/** Mirrors `ClaudeStatus` in src-tauri/src/agents.rs. */
interface ClaudeStatus {
  found: boolean;
  path?: string | null;
  version?: string | null;
  error?: string | null;
}

interface Agent {
  id: string;
  prompt: string;
  state: State;
  items: Item[];
  /** Transcript items discarded by the cap, so the count stays honest. */
  dropped: number;
  startedAt: number;
  endedAt?: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

/**
 * How much of a transcript is kept.
 *
 * The transcript is append-only and every item is a rendered DOM node, so an
 * agent doing heavy tool use grew the document without bound — and this is an
 * app you start on Monday and leave running. The newest events are the ones
 * anyone reads; the rest is scrollback nobody scrolls. The `result` item that
 * carries the final token and cost totals is copied onto the agent itself as
 * it arrives, so trimming can never lose the numbers.
 */
const MAX_ITEMS = 500;

let seq = 0;

function AgentsView(props: {
  register: (b: Binding[]) => void;
  report: (running: number, tokens: number) => void;
  project: () => Project | null;
}) {
  const [agents, setAgents] = createStore<Agent[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [draft, setDraft] = createSignal("");
  const [now, setNow] = createSignal(Date.now());

  // `now` exists only to advance the elapsed counters, so the timer exists
  // only while there is something to count. Idle — which is most of the time,
  // and all of the time for anyone who does not use this module — costs
  // nothing rather than re-rendering every card once a second forever.
  createEffect(() => {
    if (!agents.some((a) => a.state === "running")) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const [available] = createResource<ClaudeStatus>(async () =>
    hasHost() ? invoke<ClaudeStatus>("agent_available") : { found: false },
  );

  let input: HTMLInputElement | undefined;
  let releaseFocus: (() => void) | undefined;

  const current = () => agents[selected()];

  const indexOf = (id: string) => agents.findIndex((a) => a.id === id);

  createEffect(() => {
    props.report(
      agents.filter((a) => a.state === "running").length,
      agents.reduce((n, a) => n + a.inTokens + a.outTokens, 0),
    );
  });

  // Subscribe once; route each line to the agent that owns it. The disposers
  // are collected rather than assigned, because `listen` resolves
  // asynchronously and an unmount can land first — see shell/disposers.ts.
  const subs = createDisposers();

  if (hasHost()) {
    void subs.add(
      listen<{ id: string; line: string }>("agent://line", (e) => {
        const i = indexOf(e.payload.id);
        if (i === -1) return;
        const items = parseAgentLine(e.payload.line);
        if (!items.length) return;
        setAgents(
          i,
          produce((a) => {
            for (const item of items) {
              a.items.push(item);
              if (item.kind === "result") {
                a.inTokens = item.inTokens;
                a.outTokens = item.outTokens;
                a.costUsd = item.costUsd;
              }
              if (item.kind === "error") a.state = "failed";
            }
            const over = a.items.length - MAX_ITEMS;
            if (over > 0) {
              a.items.splice(0, over);
              a.dropped += over;
            }
          }),
        );
      }),
    );

    void subs.add(
      listen<{ id: string }>("agent://exit", (e) => {
        const i = indexOf(e.payload.id);
        if (i === -1) return;
        setAgents(
          i,
          produce((a) => {
            if (a.state === "running") a.state = "done";
            a.endedAt = Date.now();
          }),
        );
      }),
    );
  }

  onCleanup(() => {
    subs.dispose();
    for (const a of agents) {
      if (a.state === "running") void invoke("agent_kill", { id: a.id });
    }
  });

  async function spawn() {
    const prompt = draft().trim();
    if (!prompt || !hasHost()) return;
    const id = `agent-${++seq}`;

    setAgents(agents.length, {
      id,
      prompt,
      state: "running",
      items: [],
      dropped: 0,
      startedAt: Date.now(),
      inTokens: 0,
      outTokens: 0,
      costUsd: 0,
    });
    setSelected(agents.length - 1);
    setDraft("");

    try {
      await invoke("agent_spawn", {
        id,
        prompt,
        // Read at spawn time: an agent keeps the project it started in.
        cwd: props.project()?.path ?? ".",
        model: null,
        allowWrites: false,
      });
    } catch (err) {
      const i = indexOf(id);
      setAgents(
        i,
        produce((a) => {
          a.state = "failed";
          a.items.push({ kind: "error", text: String(err) });
        }),
      );
    }
  }

  props.register([
    {
      id: "agents.new",
      keys: "mod+enter",
      label: "New agent",
      run: () => input?.focus(),
    },
    {
      id: "agents.next",
      keys: "j",
      label: "Next agent",
      run: () => setSelected((i) => Math.min(i + 1, agents.length - 1)),
    },
    {
      id: "agents.prev",
      keys: "k",
      label: "Previous agent",
      run: () => setSelected((i) => Math.max(i - 1, 0)),
    },
    {
      id: "agents.stop",
      keys: "x",
      label: "Stop selected agent",
      run: () => {
        const a = current();
        if (a?.state === "running") void invoke("agent_kill", { id: a.id });
      },
    },
  ]);

  const elapsed = (a: Agent) => formatElapsed((a.endedAt ?? now()) - a.startedAt);

  return (
    <Switch>
      <Match when={!hasHost()}>
        <div class="panel empty-state">
          <div class="panel__label">AGENTS</div>
          <p>Agents need the Tauri host. Run `npm run tauri dev`.</p>
        </div>
      </Match>

      <Match when={available.state === "ready" && !available()?.found}>
        <div class="panel empty-state">
          <div class="panel__label">AGENTS</div>
          <Show
            when={available()?.error}
            fallback={
              <>
                <p>
                  Could not find the <code>claude</code> CLI. Agents run it as a
                  real subprocess, so no API key is stored here.
                </p>
                <p>
                  Install Claude Code, then reopen the suite. If it is already
                  installed somewhere unusual — a version manager, a custom npm
                  prefix — set <code>SUITE_CLAUDE_PATH</code> to its full path.
                </p>
              </>
            }
          >
            <p>
              Found <code>{available()?.path}</code> but it would not run:{" "}
              {available()?.error}.
            </p>
            <p>
              Check the install, or point <code>SUITE_CLAUDE_PATH</code> at a
              working binary.
            </p>
          </Show>
        </div>
      </Match>

      <Match when={available()?.found}>
        <div class="agents">
          <aside class="panel ag-queue">
            <div class="panel__label">QUEUE</div>
            <For
              each={agents}
              fallback={
                <p class="muted">
                  No agents yet. Describe a task below to start one.
                </p>
              }
            >
              {(a, i) => (
                <button
                  type="button"
                  class="ag-card"
                  data-on={i() === selected() ? "true" : "false"}
                  data-state={a.state}
                  onClick={() => setSelected(i())}
                >
                  <div class="ag-card__top">
                    <span class="ag-card__dot">●</span>
                    <span class="ag-card__id">{a.id}</span>
                    <span class="ag-card__meta">
                      {a.state === "running" ? elapsed(a) : a.state}
                      <Show when={a.inTokens + a.outTokens > 0}>
                        {" · "}
                        {formatTokens(a.inTokens + a.outTokens)} tok
                      </Show>
                    </span>
                  </div>
                  <div class="ag-card__prompt">{a.prompt}</div>
                </button>
              )}
            </For>

            <div class="keys">
              <span>⌘⏎ new</span>
              <span>j/k select</span>
              <span>x stop</span>
              <span>read-only</span>
            </div>
          </aside>

          <section class="panel ag-transcript" data-focused="true">
            <Show
              when={current()}
              fallback={
                <div class="ag-blank">
                  <p class="muted">
                    Agents run with read-only tools — Read, Glob, Grep and
                    WebFetch. They cannot edit your files.
                  </p>
                </div>
              }
            >
              {(a) => (
                <>
                  <header class="ag-head">
                    <span class="bright">{a().id}</span>
                    <span class="muted">{a().prompt}</span>
                    <span class="ag-head__right">
                      <Show when={a().costUsd > 0}>
                        ${a().costUsd.toFixed(4)} ·{" "}
                      </Show>
                      {formatTokens(a().inTokens + a().outTokens)} tok ·{" "}
                      {elapsed(a())}
                    </span>
                  </header>

                  <div class="ag-body">
                    <Show when={a().dropped > 0}>
                      <div class="ti ti--system">
                        {a().dropped} earlier events trimmed
                      </div>
                    </Show>
                    <For
                      each={a().items}
                      fallback={<p class="muted pad">waiting for first event…</p>}
                    >
                      {(item) => <TranscriptItem item={item} />}
                    </For>
                  </div>
                </>
              )}
            </Show>

            <div class="ag-prompt">
              <span class="ag-prompt__caret">❯</span>
              <input
                ref={(el) => {
                  input = el;
                  releaseFocus = shellFocus.claimText(el);
                  onCleanup(() => releaseFocus?.());
                }}
                class="ag-prompt__input"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder="describe a task for a new agent"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void spawn();
                }}
              />
              <span class="ag-prompt__keys">⏎ run</span>
            </div>
          </section>
        </div>
      </Match>
    </Switch>
  );
}

function TranscriptItem(props: { item: Item }) {
  return (
    <Switch>
      <Match when={props.item.kind === "system"}>
        <div class="ti ti--system">
          {(props.item as Extract<Item, { kind: "system" }>).model} ·{" "}
          {(props.item as Extract<Item, { kind: "system" }>).tools} tools
        </div>
      </Match>

      <Match when={props.item.kind === "text"}>
        <div class="ti ti--text">
          {(props.item as Extract<Item, { kind: "text" }>).text}
        </div>
      </Match>

      <Match when={props.item.kind === "tool"}>
        <div class="ti ti--tool">
          <span class="ti__name">
            {(props.item as Extract<Item, { kind: "tool" }>).name}
          </span>
          <span class="ti__detail">
            {(props.item as Extract<Item, { kind: "tool" }>).detail}
          </span>
        </div>
      </Match>

      <Match when={props.item.kind === "tool-result"}>
        <div
          class="ti ti--result"
          data-ok={
            (props.item as Extract<Item, { kind: "tool-result" }>).ok
              ? "true"
              : "false"
          }
        >
          {(props.item as Extract<Item, { kind: "tool-result" }>).detail}
        </div>
      </Match>

      <Match when={props.item.kind === "result"}>
        <div class="ti ti--final">
          {(props.item as Extract<Item, { kind: "result" }>).text}
        </div>
      </Match>

      <Match when={props.item.kind === "error"}>
        <div class="ti ti--error">
          {(props.item as Extract<Item, { kind: "error" }>).text}
        </div>
      </Match>
    </Switch>
  );
}

export function agentsModule(): SuiteModule {
  let dispose: (() => void) | undefined;
  let bindings: Binding[] = [];
  let running = 0;
  let tokens = 0;

  return {
    id: "agents",
    title: "AGENTS",
    version: "0.2.0",

    mount(container: HTMLElement, ctx: ModuleContext) {
      dispose = mountView(
        () => (
          <AgentsView
            register={(b) => (bindings = b)}
            project={ctx.project}
            report={(r, t) => {
              running = r;
              tokens = t;
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
      const label =
        running === 0
          ? "idle"
          : `${running} running · ${formatTokens(tokens)} tok`;
      return {
        header: label,
        home: label,
        tone: running > 0 ? ("active" as const) : ("idle" as const),
      };
    },
  };
}
