import { describe, expect, it } from "vitest";
import {
  closePane,
  focusAfterClose,
  layout,
  leaf,
  leaves,
  paneCount,
  splitAxis,
  splitPane,
} from "./panes";

describe("pane tree", () => {
  it("splits a leaf into the original plus the newcomer", () => {
    const tree = splitPane(leaf("a"), "a", "row", "b");
    expect(leaves(tree)).toEqual(["a", "b"]);
    expect(paneCount(tree)).toBe(2);
  });

  it("only splits the targeted pane", () => {
    let tree = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "col", "c");
    expect(leaves(tree)).toEqual(["a", "b", "c"]);
  });

  it("collapses the parent split into the surviving sibling on close", () => {
    let tree = splitPane(leaf("a"), "a", "row", "b");
    const after = closePane(tree, "b")!;
    expect(after).toEqual(leaf("a"));
  });

  it("returns null when the last pane closes", () => {
    expect(closePane(leaf("a"), "a")).toBeNull();
  });

  it("moves focus to the next pane, or the previous one if it was last", () => {
    let tree = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "row", "c");
    expect(focusAfterClose(tree, "b")).toBe("c");
    expect(focusAfterClose(tree, "c")).toBe("b"); // last one falls back
  });
});

describe("layout", () => {
  it("gives a lone pane the whole area", () => {
    expect(layout(leaf("a")).get("a")).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });

  it("halves horizontally for a row split", () => {
    const tree = splitPane(leaf("a"), "a", "row", "b");
    const r = layout(tree);
    expect(r.get("a")).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(r.get("b")).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  });

  it("halves vertically for a column split", () => {
    const tree = splitPane(leaf("a"), "a", "col", "b");
    const r = layout(tree);
    expect(r.get("b")).toEqual({ left: 0, top: 50, width: 100, height: 50 });
  });

  it("produces a 2×2 from two splits on opposite axes", () => {
    let tree = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "a", "col", "c");
    tree = splitPane(tree, "b", "col", "d");
    const r = layout(tree);
    expect(r.get("a")).toEqual({ left: 0, top: 0, width: 50, height: 50 });
    expect(r.get("c")).toEqual({ left: 0, top: 50, width: 50, height: 50 });
    expect(r.get("b")).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(r.get("d")).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  });

  it("tiles without gaps or overlap", () => {
    let tree = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "col", "c");
    const total = [...layout(tree).values()].reduce(
      (sum, r) => sum + r.width * r.height,
      0,
    );
    expect(total).toBeCloseTo(100 * 100);
  });
});

describe("split axis", () => {
  const wide = 16 / 9;
  const full = { left: 0, top: 0, width: 100, height: 100 };

  it("splits a full pane side by side, because it is physically wide", () => {
    expect(splitAxis(full, wide)).toBe("row");
  });

  it("then stacks, because each half is now taller than it is wide", () => {
    expect(splitAxis({ ...full, width: 50 }, wide)).toBe("col");
  });

  it("walks a 16:9 screen to a 2×2 in two splits", () => {
    let tree = splitPane(leaf("a"), "a", splitAxis(full, wide), "b");
    const half = layout(tree).get("a")!;
    tree = splitPane(tree, "a", splitAxis(half, wide), "c");
    const r = layout(tree);
    expect(r.get("a")).toEqual({ left: 0, top: 0, width: 50, height: 50 });
    expect(r.get("c")).toEqual({ left: 0, top: 50, width: 50, height: 50 });
  });

  it("respects a portrait container", () => {
    expect(splitAxis(full, 0.6)).toBe("col");
  });
});
