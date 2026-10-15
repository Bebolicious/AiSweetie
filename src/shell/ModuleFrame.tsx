import { createEffect, onCleanup, onMount } from "solid-js";
import type { ModuleContext, SuiteModule } from "@suite/module";
import { cellPosition, FACES_HOME, GRID, OFF_WORLD } from "./track";
import { edgeOf, EDGE_HUE } from "./edges";
import { ARROW, Rail } from "./Rail";
import { nav, view } from "./nav";
import { focus } from "./focus";
import { bus, router } from "./context";
import { useStatus } from "./useStatus";
import { activeProject } from "./project";

/**
 * One module, in its cell.
 *
 * The frame is keyed to the module, not to the edge — reassigning an edge
 * moves this element to a different cell rather than remounting it. That
 * matters: a terminal module carries live PTYs, and a swap must not kill them.
 */
export function ModuleFrame(props: { mod: SuiteModule }) {
  const edge = () => edgeOf(props.mod.id);
  const position = () => {
    const e = edge();
    return cellPosition(e ? GRID[e] : OFF_WORLD);
  };
  const status = useStatus(() => props.mod);

  let host!: HTMLDivElement;

  const ctx: ModuleContext = {
    // Getters, not values: reassignment re-supplies these without a remount.
    edge: () => edge() ?? "top",
    accent: () => EDGE_HUE[edge() ?? "top"],
    project: activeProject,
    bus,
    focus,
    nav,
  };

  onMount(() => {
    void Promise.resolve(props.mod.mount(host, ctx)).catch((err) =>
      console.error(`[module] "${props.mod.id}" failed to mount:`, err),
    );
  });

  onCleanup(() => {
    void Promise.resolve(props.mod.unmount()).catch((err) =>
      console.error(`[module] "${props.mod.id}" failed to unmount:`, err),
    );
  });

  // A module's keys are live only while you are looking at it. Registering on
  // focus rather than at mount is what lets two modules claim the same chord.
  createEffect(() => {
    if (view() !== edge()) return;
    const dispose = router.register(props.mod.keymap());
    onCleanup(dispose);
  });

  return (
    <section
      class="cell"
      data-view={edge() ?? "off"}
      style={{
        ...position(),
        "--accent": EDGE_HUE[edge() ?? "top"],
      }}
    >
      <header class="screen-head">
        <span class="screen-head__mark">◆ {props.mod.title}</span>
        <span class="screen-head__context">{status().header}</span>
        <button
          type="button"
          class="nav-link screen-head__right"
          onClick={() => nav.home()}
        >
          {ARROW[FACES_HOME[edge() ?? "top"]]} HOME
        </button>
      </header>

      <div class="module-body" ref={host} />

      <Rail
        side={FACES_HOME[edge() ?? "top"]}
        hue={edge() ?? "top"}
        label="Return home"
        onActivate={() => nav.home()}
      />

      <div class="hint">esc or the rail to return home</div>
    </section>
  );
}
