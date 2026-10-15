import { createSignal } from "solid-js";
import type { SuiteModule } from "@suite/module";

/**
 * The module registry. Built-in modules register at boot; `loadFromPath`
 * will import external bundles at runtime once the Rust side can serve them
 * over a custom protocol (Vite can't dynamic-import an arbitrary disk path).
 */

const [modules, setModules] = createSignal<SuiteModule[]>([]);
export { modules };

export function register(mod: SuiteModule): void {
  if (modules().some((m) => m.id === mod.id)) {
    console.warn(`[registry] "${mod.id}" already registered — ignoring`);
    return;
  }
  setModules([...modules(), mod]);
}

export function unregister(id: string): void {
  const mod = get(id);
  if (!mod) return;
  void mod.unmount();
  setModules(modules().filter((m) => m.id !== id));
}

export function get(id: string): SuiteModule | undefined {
  return modules().find((m) => m.id === id);
}
