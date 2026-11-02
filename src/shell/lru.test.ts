import { describe, expect, it } from "vitest";
import { createLru } from "./lru";

const keys = (lru: ReturnType<typeof createLru<number>>, candidates: string[]) =>
  candidates.filter((k) => lru.get(k) !== undefined);

describe("createLru", () => {
  it("stores and returns values", () => {
    const lru = createLru<number>(3);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("missing")).toBeUndefined();
  });

  it("never grows past its capacity", () => {
    const lru = createLru<number>(3);
    for (let i = 0; i < 20; i++) lru.set(`k${i}`, i);
    expect(lru.size).toBe(3);
  });

  it("evicts the least recently inserted when nothing has been read", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
  });

  it("promotes an entry on read, so it survives eviction", () => {
    // The property that makes it an LRU rather than a FIFO: clicking back to
    // a file you already looked at should keep it, not age it out.
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // "a" is now the most recent
    lru.set("c", 3); // so "b" is the one to go

    expect(keys(lru, ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("treats overwriting as a use", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 99); // refreshes "a" in the eviction order as well as its value
    lru.set("c", 3);

    expect(lru.get("a")).toBe(99);
    expect(lru.get("b")).toBeUndefined();
  });

  it("returns the value from set, for use in an expression", () => {
    const lru = createLru<string>(2);
    expect(lru.set("a", "value")).toBe("value");
  });

  it("clears", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get("a")).toBeUndefined();
  });

  it("refuses to be a cache that stores nothing", () => {
    // Capacity 0 would otherwise evict each value as it was inserted.
    const lru = createLru<number>(0);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.size).toBe(1);
  });
});
