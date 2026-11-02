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

/** Adopt persisted performance toggles (ROADMAP 0.1). */
export function hydratePrefs(stored: {
  hardware_accel?: boolean;
  panel_blur?: boolean;
  bounce?: boolean;
}): void {
  // Each is checked for presence rather than truthiness: `false` is a
  // meaningful value here, and `stored.panel_blur || true` would silently
  // ignore the one setting a user is most likely to have turned off.
  if (typeof stored.hardware_accel === "boolean")
    setHardwareAccel(stored.hardware_accel);
  if (typeof stored.panel_blur === "boolean") setPanelBlur(stored.panel_blur);
  if (typeof stored.bounce === "boolean") setBounce(stored.bounce);
}

/** The current toggles, shaped for `config.toml`. */
export function collectPrefs() {
  return {
    hardware_accel: hardwareAccel(),
    panel_blur: panelBlur(),
    bounce: bounce(),
  };
}

/** Push preference state onto the document root, where the CSS reads it. */
export function syncPrefsToDom(): void {
  const root = document.documentElement;
  root.dataset.blur = panelBlur() ? "on" : "off";
  root.dataset.accel = hardwareAccel() ? "on" : "off";
  root.dataset.bounce = bounce() ? "on" : "off";
}
