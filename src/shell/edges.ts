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

/**
 * Adopt a persisted assignment (ROADMAP 0.1).
 *
 * Validated field by field rather than trusted, because `config.toml` is
 * hand-editable: a typo'd module id would otherwise leave an edge pointing at
 * nothing, and `ModuleFrame` would render a header with an empty body — the
 * exact symptom of the HMR gap in §7, which is a miserable thing to debug.
 * `known` is the registry's ids; anything unrecognised keeps its default and
 * says so.
 */
export function hydrateEdges(
  stored: Partial<Record<Edge, string>>,
  known: readonly string[],
): void {
  const next = {} as Assignment;
  const claimed = new Set<string>();

  // Pass one: honour what the file asks for, where it can be honoured.
  for (const edge of EDGES) {
    const id = stored[edge];
    if (!id) continue;

    if (!known.includes(id)) {
      console.warn(
        `[config] [edges] ${edge} = "${id}" is not a known module — ignoring`,
      );
      continue;
    }
    // One module cannot hold two edges: the frame is keyed to the module, so
    // the second assignment moves the same element and leaves an edge
    // unreachable. First writer wins; the loser falls through to pass two.
    if (claimed.has(id)) {
      console.warn(
        `[config] [edges] "${id}" is already on another edge — ignoring ${edge}`,
      );
      continue;
    }
    next[edge] = id;
    claimed.add(id);
  }

  // Pass two: fill the rest, preferring each edge's default when it is still
  // free, then anything left over.
  //
  // Filling from what remains rather than resetting to the default is the
  // whole point. Resetting looked right and was not: a partial `top =
  // "terminal"` collides with `right`'s own default of terminal, and
  // "reset right to its default" puts terminal straight back, leaving two
  // edges on terminal and `git` on none.
  const spare = [...known, ...EDGES.map((e) => DEFAULT[e])].filter(
    (id) => !claimed.has(id),
  );
  for (const edge of EDGES) {
    if (next[edge]) continue;

    const preferred = !claimed.has(DEFAULT[edge]) ? DEFAULT[edge] : spare.shift();
    if (preferred === undefined) {
      // Fewer modules than edges — unavoidable, and the default is as good an
      // answer as exists. Only reachable with a trimmed registry.
      next[edge] = DEFAULT[edge];
      continue;
    }
    next[edge] = preferred;
    claimed.add(preferred);
    const at = spare.indexOf(preferred);
    if (at !== -1) spare.splice(at, 1);
  }

  setAssignment(next);
}

/** The current assignment, shaped for `config.toml`. */
export function collectEdges(): Record<Edge, string> {
  return { ...assignment() };
}

/** Edge hues follow the direction, never the module. */
export const EDGE_HUE: Record<Edge, string> = {
  top: "var(--edge-top)",
  right: "var(--edge-right)",
  bottom: "var(--edge-bottom)",
  left: "var(--edge-left)",
};
