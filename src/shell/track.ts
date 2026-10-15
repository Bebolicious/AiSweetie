import type { Edge } from "@suite/module";

export type View = "home" | Edge;

/**
 * The world is a 3×3 grid of full-viewport cells. Home sits at the centre and
 * each module parks one cell out in its own direction, so sliding "toward the
 * top edge" is literally moving the world down by one cell.
 *
 * Nothing inside a cell animates. The track moves; content is static. That is
 * why the swap can stay on one composited layer.
 */
export const GRID: Record<View, readonly [number, number]> = {
  home: [1, 1],
  top: [1, 0],
  right: [2, 1],
  bottom: [1, 2],
  left: [0, 1],
};

/** A module with no edge parks outside the 3×3 and is never reachable. */
export const OFF_WORLD: readonly [number, number] = [4, 4];

/**
 * The track is 300% of the viewport in both axes, so one cell is a third of
 * the track. Percentages rather than the prototype's hardcoded 1920/1080 —
 * that is what makes the layout fluid instead of scaled.
 */
export const CELL = 100 / 3;

export function cellPosition([col, row]: readonly [number, number]) {
  return { left: `${col * CELL}%`, top: `${row * CELL}%` };
}

export function trackTransform([col, row]: readonly [number, number]) {
  return `translate3d(${-col * CELL}%, ${-row * CELL}%, 0)`;
}

/** The edge whose arrow points back at home from a given view. */
export const BACK_FROM: Record<Edge, Edge> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/** Which side of a module's screen faces home. */
export const FACES_HOME = BACK_FROM;
