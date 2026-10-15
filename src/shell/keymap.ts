import type { Binding } from "@suite/module";
import { focus, blurActiveText } from "./focus";

const IS_MAC = /Mac|iPhone|iPad/.test(
  navigator.userAgent + " " + (navigator.platform ?? ""),
);

/** How "mod" prints in the UI. The mock's ⌘K is Ctrl+K on Windows and Linux. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

function keyName(e: KeyboardEvent): string {
  const k = e.key;
  if (k === " ") return "space";
  if (k.startsWith("Arrow")) return k.slice(5).toLowerCase();
  return k.toLowerCase();
}

/**
 * Normalize an event to a chord string: "mod+k", "shift+g", "space", ",".
 * "mod" is Cmd on macOS and Ctrl elsewhere, so bindings stay platform-neutral
 * in config.toml.
 */
export function chord(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const secondary = IS_MAC ? e.ctrlKey : e.metaKey;
  if (mod) parts.push("mod");
  if (secondary) parts.push(IS_MAC ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(keyName(e));
  return parts.join("+");
}

/** Shift alone is not a modifier here — shift+G is still typing. */
function hasCommandModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

export interface Router {
  /** Later registrations win, so a focused module can shadow a global key. */
  register(bindings: Binding[]): () => void;
  all(): Binding[];
  handle(e: KeyboardEvent): void;
}

export function createRouter(): Router {
  const layers: Binding[][] = [];

  return {
    register(bindings) {
      layers.push(bindings);
      return () => {
        const i = layers.indexOf(bindings);
        if (i !== -1) layers.splice(i, 1);
      };
    },

    all() {
      return layers.flat();
    },

    handle(e) {
      // Escape unwinds one level at a time: leave the text surface first.
      if (e.key === "Escape" && blurActiveText()) {
        e.preventDefault();
        return;
      }

      // While something is taking text, only chords with a real modifier are
      // commands. Everything else is the user typing.
      if (focus.hasTextFocus() && !hasCommandModifier(e)) return;

      const pressed = chord(e);
      for (let i = layers.length - 1; i >= 0; i--) {
        const hit = layers[i].find((b) => b.keys === pressed);
        if (hit) {
          e.preventDefault();
          hit.run();
          return;
        }
      }
    },
  };
}
