import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { EDGES, type Edge } from "@suite/module";
import { cellPosition, GRID } from "../shell/track";
import { EDGE_HUE, moduleAt } from "../shell/edges";
import { get } from "../shell/registry";
import { nav, view } from "../shell/nav";
import { router } from "../shell/context";
import { ARROW, Rail } from "../shell/Rail";
import { useStatus } from "../shell/useStatus";
import { Clock } from "./Clock";
import { Projects } from "./Projects";
import { PromptPill } from "./PromptPill";

function EdgeRow(props: { edge: Edge; index: number }) {
  const mod = () => get(moduleAt(props.edge));
  const status = useStatus(mod);

  return (
    <button
      type="button"
      class="edge-row"
      onClick={() => nav.toEdge(props.edge)}
      style={{ "--accent": EDGE_HUE[props.edge] }}
    >
      <span class="edge-row__arrow">{ARROW[props.edge]}</span>
      <span class="edge-row__name">{mod()?.title ?? "—"}</span>
      <span class="edge-row__status">{status().home}</span>
      <span class="edge-row__index">edge {props.index}</span>
    </button>
  );
}

export function Home(props: { onOpenSettings: () => void }) {
  const [pickerOpen, setPickerOpen] = createSignal(false);

  // Home's own keys, live only while home is in view — the same rule a
  // module's keymap follows, so `o` is free for modules to use.
  createEffect(() => {
    if (view() !== "home") return;
    const dispose = router.register([
      {
        id: "home.openProject",
        keys: "o",
        label: "Open a project",
        run: () => setPickerOpen(true),
      },
    ]);
    onCleanup(dispose);
  });

  return (
    <section class="cell" data-view="home" style={cellPosition(GRID.home)}>
      <header class="screen-head">
        <span class="screen-head__mark" style={{ "--accent": "var(--teal)" }}>
          ● HOME
        </span>
        <For each={EDGES}>
          {(edge) => (
            <button
              type="button"
              class="nav-link"
              onClick={() => nav.toEdge(edge)}
            >
              {ARROW[edge]}{" "}
              <Show when={get(moduleAt(edge))} fallback="—">
                {(mod) => mod().title}
              </Show>
            </button>
          )}
        </For>
        <span class="screen-head__right">
          <span>arrows to swap · esc home</span>
          <button
            type="button"
            class="chip"
            onClick={props.onOpenSettings}
            aria-label="Open settings"
          >
            ⚙ settings <span class="chip__key">,</span>
          </button>
        </span>
      </header>

      <div class="home-grid">
        <Clock />

        <Projects
          pickerOpen={pickerOpen()}
          onOpenPicker={() => setPickerOpen(true)}
          onClosePicker={() => setPickerOpen(false)}
        />

        <div class="panel edge-map">
          <div class="panel__label">EDGE MAP</div>
          <For each={EDGES}>
            {(edge, i) => <EdgeRow edge={edge} index={i() + 1} />}
          </For>
        </div>
      </div>

      <PromptPill />

      <For each={EDGES}>
        {(edge) => (
          <Rail
            side={edge}
            hue={edge}
            label={`Go to ${get(moduleAt(edge))?.title ?? edge}`}
            onActivate={() => nav.toEdge(edge)}
          />
        )}
      </For>

      <div class="hint">arrows or click an edge rail</div>
    </section>
  );
}
