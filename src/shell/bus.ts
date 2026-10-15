import type { Bus, BusEvents } from "@suite/module";

type Handler = (payload: never) => void;

/**
 * Cross-module messaging. A terminal pane hands a file to git; a failing test
 * goes to an agent. Modules never hold references to each other.
 */
export function createBus(): Bus {
  const handlers = new Map<keyof BusEvents, Set<Handler>>();

  return {
    emit(k, payload) {
      const set = handlers.get(k);
      if (!set) return;
      // Copy first: a handler may unsubscribe during dispatch.
      for (const fn of [...set]) {
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (err) {
          console.error(`[bus] handler for "${String(k)}" threw:`, err);
        }
      }
    },

    on(k, fn) {
      let set = handlers.get(k);
      if (!set) handlers.set(k, (set = new Set()));
      set.add(fn as Handler);
      return () => set!.delete(fn as Handler);
    },
  };
}
