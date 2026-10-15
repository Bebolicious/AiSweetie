/**
 * The pane tree.
 *
 * A binary tree of splits, which is how every tiling multiplexer models this:
 * splitting a pane replaces that leaf with a split node holding the original
 * and the newcomer. Pure functions so the layout logic is testable without a
 * DOM, a PTY, or a running app.
 */

export type PaneId = string;
export type SplitDir = "row" | "col";

export type Node =
  | { kind: "leaf"; id: PaneId }
  | { kind: "split"; dir: SplitDir; a: Node; b: Node };

export const leaf = (id: PaneId): Node => ({ kind: "leaf", id });

/** Every pane id in the tree, left to right, depth first. */
export function leaves(node: Node): PaneId[] {
  return node.kind === "leaf"
    ? [node.id]
    : [...leaves(node.a), ...leaves(node.b)];
}

export function paneCount(node: Node): number {
  return leaves(node).length;
}

/** Replace `target` with a split holding it and a new pane. */
export function splitPane(
  node: Node,
  target: PaneId,
  dir: SplitDir,
  newId: PaneId,
): Node {
  if (node.kind === "leaf") {
    return node.id === target
      ? { kind: "split", dir, a: node, b: leaf(newId) }
      : node;
  }
  return {
    ...node,
    a: splitPane(node.a, target, dir, newId),
    b: splitPane(node.b, target, dir, newId),
  };
}

/**
 * Remove a pane, collapsing its parent split into the surviving sibling.
 * Returns null when the last pane closes — the caller decides what that means.
 */
export function closePane(node: Node, target: PaneId): Node | null {
  if (node.kind === "leaf") return node.id === target ? null : node;

  const a = closePane(node.a, target);
  const b = closePane(node.b, target);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/**
 * Which pane should take focus after `target` closes: the next leaf to the
 * right, or the previous one if it was last. Never returns the closed pane.
 */
export function focusAfterClose(node: Node, target: PaneId): PaneId | null {
  const ids = leaves(node);
  const i = ids.indexOf(target);
  if (i === -1) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL: Rect = { left: 0, top: 0, width: 100, height: 100 };

/**
 * Flatten the tree into one rect per pane, in percentages.
 *
 * Panes are then rendered as a flat keyed list rather than a nested one. That
 * is not a style preference: a nested render would rebuild the DOM subtree on
 * every split, unmounting live terminals and killing their PTYs. Flattening
 * means a split mounts exactly one new pane and merely repositions the rest.
 */
export function layout(node: Node, rect: Rect = FULL): Map<PaneId, Rect> {
  if (node.kind === "leaf") return new Map([[node.id, rect]]);

  const [a, b] =
    node.dir === "row"
      ? [
          { ...rect, width: rect.width / 2 },
          { ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 },
        ]
      : [
          { ...rect, height: rect.height / 2 },
          { ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 },
        ];

  return new Map([...layout(node.a, a), ...layout(node.b, b)]);
}

/**
 * Split whichever axis is physically longer, which is what produces a natural
 * 2×2 as you keep splitting.
 *
 * Rects are percentages, so they say nothing about shape on their own: a full
 * pane is 100×100 but is physically as wide as the display. The container's
 * aspect ratio is what converts one into the other.
 */
export function splitAxis(rect: Rect, aspect: number): SplitDir {
  return rect.width * aspect >= rect.height ? "row" : "col";
}
