import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
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

  /**
   * Set when `mount()` itself failed, as opposed to the view throwing later —
   * `mountView`'s boundary handles the latter, but it never gets the chance if
   * the module died before it rendered anything.
   */
  const [mountError, setMountError] = createSignal<unknown>(null);

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
    const failed = (err: unknown) => {
      console.error(`[module] "${props.mod.id}" failed to mount:`, err);
      setMountError(err);
    };
    // try/catch as well as .catch(): `mount()` is called to produce the value
    // `Promise.resolve` wraps, so a *synchronous* throw happens before there
    // is a promise to attach a handler to, and escapes into the shell's own
    // reactive root — which is the one failure that can blank the whole app.
    try {
      const pending = props.mod.mount(host, ctx);
      if (pending) void Promise.resolve(pending).catch(failed);
    } catch (err) {
      failed(err);
    }
  });

  onCleanup(() => {
    try {
      const pending = props.mod.unmount();
      if (pending) {
        void Promise.resolve(pending).catch((err) =>
          console.error(`[module] "${props.mod.id}" failed to unmount:`, err),
        );
      }
    } catch (err) {
      console.error(`[module] "${props.mod.id}" failed to unmount:`, err);
    }
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
      // Drives the blur gating in shell.css — an off-screen cell pays nothing.
      data-live={view() === edge() ? "true" : "false"}
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

      {/* The host div is the fallback so that `ref` is assigned before
          onMount runs. It is replaced only if mounting actually failed. */}
      <Show when={mountError()} fallback={<div class="module-body" ref={host} />}>
        {(err) => (
          <div class="module-body">
            <div class="panel empty-state">
              <div class="panel__label">{props.mod.title} FAILED TO START</div>
              <p>
                This module threw while mounting, so it has nothing to show.
                The other edges still work — <code>esc</code> returns home.
              </p>
              <p>
                <code>
                  {err() instanceof Error
                    ? (err() as Error).message
                    : String(err())}
                </code>
              </p>
            </div>
          </div>
        )}
      </Show>

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
