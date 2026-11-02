import { describe, expect, it, vi } from "vitest";
import { createDisposers } from "./disposers";

/** A promise with its resolver exposed, so a test can decide the timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createDisposers", () => {
  it("runs held disposers on dispose", async () => {
    const subs = createDisposers();
    const a = vi.fn();
    const b = vi.fn();

    await subs.add(Promise.resolve(a));
    await subs.add(Promise.resolve(b));
    subs.dispose();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("disposes a subscription that arrives after disposal", async () => {
    // The whole reason this exists: unmount lands while `listen()` is still
    // in flight. The disposer must not be quietly kept by nobody.
    const subs = createDisposers();
    const late = deferred<() => void>();
    const unlisten = vi.fn();

    const pending = subs.add(late.promise);
    subs.dispose();
    late.resolve(unlisten);
    await pending;

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("reports disposal so in-flight work can bail out", async () => {
    const subs = createDisposers();
    expect(subs.disposed).toBe(false);
    subs.dispose();
    expect(subs.disposed).toBe(true);
  });

  it("does not dispose twice", async () => {
    const subs = createDisposers();
    const a = vi.fn();

    await subs.add(Promise.resolve(a));
    subs.dispose();
    subs.dispose();

    expect(a).toHaveBeenCalledOnce();
  });

  it("keeps disposing after one throws", async () => {
    const subs = createDisposers();
    const boom = vi.fn(() => {
      throw new Error("nope");
    });
    const after = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await subs.add(Promise.resolve(boom));
    await subs.add(Promise.resolve(after));
    subs.dispose();

    expect(after).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
