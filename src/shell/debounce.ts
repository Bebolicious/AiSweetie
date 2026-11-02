import { createEffect, createSignal, on, onCleanup } from "solid-js";

/**
 * A signal that follows `source`, but only once it has stopped changing.
 *
 * For keying expensive work off a value that can change in bursts — a
 * resource fetch, a parse, anything synchronous and long. The cheap half of a
 * UI should track the source directly and stay instant; only the expensive
 * half reads this.
 *
 * Each change cancels the previous timer via `onCleanup` inside the effect,
 * which is what makes this trailing-edge rather than throttling.
 */
export function debounced<T>(source: () => T, ms: number): () => T {
  const [value, setValue] = createSignal<T>(source());

  createEffect(
    on(
      source,
      (next) => {
        const timer = setTimeout(() => setValue(() => next), ms);
        onCleanup(() => clearTimeout(timer));
      },
      // The initial value is already in the signal; waiting `ms` to re-set it
      // to itself would just delay the first render for nothing.
      { defer: true },
    ),
  );

  return value;
}
