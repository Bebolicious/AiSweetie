import { createSignal, onCleanup } from "solid-js";
import type { StatusSummary, SuiteModule } from "@suite/module";
import { moving } from "./nav";

const IDLE: StatusSummary = { header: "", home: "" };

/**
 * Two summaries are the same summary if they read the same.
 *
 * `status()` returns a fresh object every call, and a signal holding an object
 * notifies on every write regardless of content — so nine pollers (one per
 * `ModuleFrame`, one per home `EdgeRow`, one in `Projects`) were pushing nine
 * updates a second through the DOM to write the same strings back. Comparing
 * the three fields turns the steady state into nine no-ops.
 */
function same(a: StatusSummary, b: StatusSummary): boolean {
  return a.header === b.header && a.home === b.home && a.tone === b.tone;
}

/**
 * `status()` is a plain synchronous call by contract — modules don't push.
 * The shell polls instead, which keeps the contract small and means a badly
 * behaved module can't spam re-renders.
 */
export function useStatus(mod: () => SuiteModule | undefined, ms = 1000) {
  const read = (): StatusSummary => {
    const m = mod();
    if (!m) return IDLE;
    try {
      return m.status();
    } catch (err) {
      console.error(`[status] "${m.id}" threw:`, err);
      return IDLE;
    }
  };

  const [status, setStatus] = createSignal<StatusSummary>(read(), {
    equals: same,
  });

  const timer = setInterval(() => {
    // Not while the world is in flight. A status string is never worth a style
    // recalc during the one interaction that must not drop a frame, and all
    // five cells share a single composited layer — so an update to an
    // off-screen cell still lands on the layer being animated.
    if (moving()) return;
    setStatus(read());
  }, ms);

  onCleanup(() => clearInterval(timer));
  return status;
}
