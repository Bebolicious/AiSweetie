import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { StatusSummary, SuiteModule } from "@suite/module";
import { useStatus } from "./useStatus";
import { go, moving } from "./nav";

/** A module whose `status()` is whatever the test currently wants it to be. */
function fakeModule(status: () => StatusSummary): SuiteModule {
  return {
    id: "fake",
    title: "FAKE",
    version: "0.0.0",
    mount() {},
    unmount() {},
    keymap: () => [],
    status,
  };
}

describe("useStatus", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    // nav is a module-level singleton; put the world back on home and let the
    // settle timer run out so one test cannot leave `moving` true for the next.
    go("home");
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
  });

  it("does not write the signal when the status reads the same", () => {
    // `status()` returns a fresh object every call, so without `equals` every
    // poll is a write and every consumer re-renders. Reference identity is the
    // observable proof that no write happened.
    const mod = fakeModule(() => ({ header: "a", home: "b", tone: "idle" }));

    createRoot((dispose) => {
      const status = useStatus(() => mod, 10);
      const first = status();

      vi.advanceTimersByTime(100); // ten polls
      expect(status()).toBe(first);

      dispose();
    });
  });

  it("writes the signal when the status actually changes", () => {
    let header = "one";
    const mod = fakeModule(() => ({ header, home: header }));

    createRoot((dispose) => {
      const status = useStatus(() => mod, 10);
      expect(status().header).toBe("one");

      header = "two";
      vi.advanceTimersByTime(20);
      expect(status().header).toBe("two");

      dispose();
    });
  });

  it("stops polling while the world is in flight", () => {
    let calls = 0;
    const mod = fakeModule(() => {
      calls++;
      return { header: String(calls), home: "" };
    });

    createRoot((dispose) => {
      useStatus(() => mod, 10);
      const atStart = calls;

      go("top");
      expect(moving()).toBe(true);

      // The swap is 440ms and `moving` covers it; nothing should be read.
      vi.advanceTimersByTime(400);
      expect(calls).toBe(atStart);

      // Once it settles, polling resumes.
      vi.advanceTimersByTime(200);
      expect(calls).toBeGreaterThan(atStart);

      dispose();
    });
  });

  it("survives a module whose status() throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = fakeModule(() => {
      throw new Error("bad status");
    });

    createRoot((dispose) => {
      const status = useStatus(() => mod, 10);
      expect(status().header).toBe("");
      vi.advanceTimersByTime(30);
      expect(status().header).toBe("");
      dispose();
    });

    spy.mockRestore();
  });
});
