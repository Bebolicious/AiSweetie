import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { EDGES, type Binding } from "@suite/module";
import { BACK_FROM, GRID, trackTransform } from "./track";
import { go, moving, nav, view } from "./nav";
import { modules } from "./registry";
import { router } from "./context";
import { syncPrefsToDom } from "./prefs";
import { ModuleFrame } from "./ModuleFrame";
import { Settings } from "./Settings";
import { Home } from "../home/Home";
import { setFullscreen, quit } from "./host";

export function App() {
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [fullscreen, setFullscreenState] = createSignal(true);

  createEffect(syncPrefsToDom);

  const globals: Binding[] = [
    ...EDGES.map((edge) => ({
      id: `shell.edge.${edge}`,
      keys: edge === "top" ? "up" : edge === "bottom" ? "down" : edge,
      label: `Swap to ${edge} edge`,
      run: () => {
        // From an edge, the arrow pointing back at home returns home rather
        // than leaping to the opposite module.
        const current = view();
        if (current !== "home" && BACK_FROM[current] === edge) nav.home();
        else go(edge);
      },
    })),
    {
      id: "shell.home",
      keys: "escape",
      label: "Back to home",
      run: () => nav.home(),
    },
    {
      id: "shell.settings",
      keys: ",",
      label: "Settings",
      run: () => setSettingsOpen(true),
    },
    {
      id: "shell.fullscreen",
      keys: "f11",
      label: "Toggle fullscreen",
      run: () => {
        const next = !fullscreen();
        setFullscreenState(next);
        void setFullscreen(next);
      },
    },
    {
      id: "shell.quit",
      keys: "mod+q",
      label: "Quit suite",
      run: () => void quit(),
    },
  ];

  onMount(() => {
    const dispose = router.register(globals);
    const onKey = (e: KeyboardEvent) => router.handle(e);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      dispose();
      window.removeEventListener("keydown", onKey);
    });
  });

  // While Settings is open it owns the keyboard: escape closes it, and the
  // arrows must not slide the world out from under the modal.
  createEffect(() => {
    if (!settingsOpen()) return;
    const layer: Binding[] = [
      {
        id: "settings.close",
        keys: "escape",
        label: "Close settings",
        run: () => setSettingsOpen(false),
      },
      ...EDGES.map((edge) => ({
        id: `settings.block.${edge}`,
        keys: edge === "top" ? "up" : edge === "bottom" ? "down" : edge,
        label: "",
        run: () => {},
      })),
    ];
    const dispose = router.register(layer);
    onCleanup(dispose);
  });

  return (
    <div class="world">
      <div
        class="track"
        data-moving={moving() ? "true" : "false"}
        style={{ transform: trackTransform(GRID[view()]) }}
      >
        <Home onOpenSettings={() => setSettingsOpen(true)} />
        <For each={modules()}>{(mod) => <ModuleFrame mod={mod} />}</For>
      </div>

      <Show when={settingsOpen()}>
        <Settings onClose={() => setSettingsOpen(false)} />
      </Show>
    </div>
  );
}
