import type { FocusScope } from "@suite/module";

/**
 * The global focus model.
 *
 * Bare keys are commands only when nothing is taking text. Without this,
 * typing a comma into the home prompt bar opens Settings, `c` in a commit
 * message commits, and `/` in a filename starts a find. The shell decides;
 * modules only declare which of their elements take text.
 */

const claimed = new WeakSet<HTMLElement>();

function isNativeTextTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  // Checkboxes and buttons are inputs but do not take text.
  const type = (el as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(
    type,
  );
}

export const focus: FocusScope = {
  claimText(el) {
    claimed.add(el);
    return () => claimed.delete(el);
  },

  hasTextFocus() {
    const active = document.activeElement;
    if (!active) return false;
    if (active instanceof HTMLElement && claimed.has(active)) return true;
    return isNativeTextTarget(active);
  },
};

/** Escape leaves the text surface before it means anything else. */
export function blurActiveText(): boolean {
  if (!focus.hasTextFocus()) return false;
  (document.activeElement as HTMLElement).blur();
  return true;
}
