import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEffect, createRoot, createSignal } from "solid-js";
import { debounced } from "./debounce";

/**
 * Effects created inside `createRoot` do not run until its body returns, so
 * every test here builds the graph first and only then changes the source —
 * otherwise the debounce effect has not subscribed yet and the test is
 * measuring nothing.
 */
function harness<T>(initial: T, ms: number) {
  let setSource!: (v: T) => void;
  let slow!: () => T;
  let dispose!: () => void;
  const seen: T[] = [];

  createRoot((d) => {
    dispose = d;
    const [source, set] = createSignal<T>(initial);
    // Always set the literal value: Solid's setter treats a bare function
    // argument as an updater, which would call a function-typed T instead of
    // storing it — a trap in the harness, not in `debounced`.
    setSource = (v: T) => set(() => v);
    slow = debounced(source, ms);
    createEffect(() => seen.push(slow()));
  });

  return { setSource, slow, seen, dispose };
}

describe("debounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts at the source's current value", () => {
    const h = harness("first", 100);
    expect(h.slow()).toBe("first");
    expect(h.seen).toEqual(["first"]);
    h.dispose();
  });

  it("collapses a burst into the final value", () => {
    const h = harness("a", 100);

    h.setSource("ab");
    vi.advanceTimersByTime(50);
    h.setSource("abc");
    vi.advanceTimersByTime(50);
    h.setSource("abcd");

    // Nothing has settled: each change cancelled the previous timer.
    expect(h.slow()).toBe("a");

    vi.advanceTimersByTime(100);
    expect(h.slow()).toBe("abcd");

    h.dispose();
  });

  it("never takes an intermediate value", () => {
    // The property that matters: whatever reads this never sees 1 or 2, so
    // the expensive work keyed off it runs once instead of three times.
    const h = harness(0, 100);

    h.setSource(1);
    vi.advanceTimersByTime(10);
    h.setSource(2);
    vi.advanceTimersByTime(10);
    h.setSource(3);
    vi.advanceTimersByTime(200);

    expect(h.seen).toEqual([0, 3]);
    h.dispose();
  });

  it("settles after the source stops changing", () => {
    const h = harness("x", 100);

    h.setSource("y");
    vi.advanceTimersByTime(99);
    expect(h.slow()).toBe("x");
    vi.advanceTimersByTime(2);
    expect(h.slow()).toBe("y");

    h.dispose();
  });

  it("holds a function value rather than calling it", () => {
    // `setValue(() => next)` would otherwise treat a function source value as
    // an updater — worth a test since T is unconstrained.
    const target = () => "payload";
    const h = harness<() => string>(() => "initial", 10);

    h.setSource(target);
    vi.advanceTimersByTime(20);

    expect(h.slow()).toBe(target);
    expect(h.slow()()).toBe("payload");
    h.dispose();
  });
});
