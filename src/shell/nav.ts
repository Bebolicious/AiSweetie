import { createSignal } from "solid-js";
import type { Nav } from "@suite/module";
import type { View } from "./track";

const [view, setView] = createSignal<View>("home");
const [moving, setMoving] = createSignal(false);
export { view, moving };

let settle: ReturnType<typeof setTimeout> | undefined;

export function go(next: View): void {
  if (next === view()) return;
  setView(next);
  setMoving(true);
  clearTimeout(settle);
  // Just past the 440ms curve, so `moving` covers the overshoot too.
  settle = setTimeout(() => setMoving(false), 460);
}

export const nav: Nav = {
  home: () => go("home"),
  toEdge: (edge) => go(edge),
};
