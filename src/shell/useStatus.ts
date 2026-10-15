import { createSignal, onCleanup } from "solid-js";
import type { StatusSummary, SuiteModule } from "@suite/module";

const IDLE: StatusSummary = { header: "", home: "" };

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

  const [status, setStatus] = createSignal<StatusSummary>(read());
  const timer = setInterval(() => setStatus(read()), ms);
  onCleanup(() => clearInterval(timer));
  return status;
}
