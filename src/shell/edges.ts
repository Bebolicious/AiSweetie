import { createSignal } from "solid-js";
import { EDGES, type Edge } from "@suite/module";

/** Which module id sits on which edge. User configuration, not code. */
export type Assignment = Record<Edge, string>;

const DEFAULT: Assignment = {
  top: "git",
  right: "terminal",
  bottom: "explorer",
  left: "agents",
};

const [assignment, setAssignment] = createSignal<Assignment>(DEFAULT);
export { assignment };

export function moduleAt(edge: Edge): string {
  return assignment()[edge];
}

export function edgeOf(id: string): Edge | undefined {
  return EDGES.find((e) => assignment()[e] === id);
}

/**
 * Assigning a module that already holds an edge swaps the two, so every edge
 * always has exactly one module and no module is ever orphaned by a reassign.
 */
export function assign(edge: Edge, id: string): void {
  const current = assignment();
  if (current[edge] === id) return;

  const previousEdge = edgeOf(id);
  const next: Assignment = { ...current, [edge]: id };
  if (previousEdge) next[previousEdge] = current[edge];
  setAssignment(next);
}

/** Edge hues follow the direction, never the module. */
export const EDGE_HUE: Record<Edge, string> = {
  top: "var(--edge-top)",
  right: "var(--edge-right)",
  bottom: "var(--edge-bottom)",
  left: "var(--edge-left)",
};
