import { createSignal } from "solid-js";

/**
 * Settings → Performance. These exist because the compositor aesthetic is
 * expensive: heavy backdrop blur is the first thing to fall over on a weak
 * GPU or on Linux/WebKitGTK, and the swap has to stay smooth regardless.
 */

/** GPU compositing for the swap. Off drops the promoted layer. */
export const [hardwareAccel, setHardwareAccel] = createSignal(true);

/** Backdrop blur behind floating panels. */
export const [panelBlur, setPanelBlur] = createSignal(true);

/** Spring overshoot on swap. Off is a flat 260ms ease. */
export const [bounce, setBounce] = createSignal(true);

/** Push preference state onto the document root, where the CSS reads it. */
export function syncPrefsToDom(): void {
  const root = document.documentElement;
  root.dataset.blur = panelBlur() ? "on" : "off";
  root.dataset.accel = hardwareAccel() ? "on" : "off";
  root.dataset.bounce = bounce() ? "on" : "off";
}
