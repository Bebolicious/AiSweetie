import type { Edge } from "@suite/module";
import { EDGE_HUE } from "./edges";

/**
 * A thin glowing bar at a screen edge. Clicking it is the mouse equivalent of
 * pressing the arrow key toward it.
 *
 * `side` is where the rail sits; `hue` is which edge's color it carries. On
 * home these match. On a module screen the rail sits on the side facing home
 * but keeps its own edge's hue, so the color you came in on is the color you
 * leave by.
 */
export function Rail(props: {
  side: Edge;
  hue: Edge;
  label: string;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      class="rail"
      data-side={props.side}
      style={{ "--rail-hue": EDGE_HUE[props.hue] }}
      aria-label={props.label}
      onClick={props.onActivate}
    >
      <span class="rail__bar" />
    </button>
  );
}

export const ARROW: Record<Edge, string> = {
  top: "↑",
  right: "→",
  bottom: "↓",
  left: "←",
};
