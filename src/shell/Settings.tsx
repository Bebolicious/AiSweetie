import { For } from "solid-js";
import { EDGES, type Edge } from "@suite/module";
import { assign, assignment, EDGE_HUE, edgeOf } from "./edges";
import { modules } from "./registry";
import { router } from "./context";
import { MOD_LABEL } from "./keymap";
import { ARROW } from "./Rail";
import {
  bounce,
  hardwareAccel,
  panelBlur,
  setBounce,
  setHardwareAccel,
  setPanelBlur,
} from "./prefs";

function Toggle(props: {
  label: string;
  detail: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="setting">
      <div class="setting__text">
        <div class="setting__label">{props.label}</div>
        <div class="setting__detail">{props.detail}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.value}
        aria-label={props.label}
        class="switch"
        data-on={props.value}
        onClick={() => props.onChange(!props.value)}
      >
        <span class="switch__knob" />
      </button>
    </div>
  );
}

/** Print a stored chord the way the mock does: "mod+k" → "Ctrl K". */
function prettyKeys(keys: string): string {
  return keys
    .split("+")
    .map((part) => {
      if (part === "mod") return MOD_LABEL;
      if (part === "escape") return "esc";
      if (part === "space") return "␣";
      if (["up", "down", "left", "right"].includes(part))
        return ARROW[part === "up" ? "top" : part === "down" ? "bottom" : (part as Edge)];
      return part.length === 1 ? part : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function Settings(props: { onClose: () => void }) {
  // Every binding in the app, gathered from the router rather than a
  // hand-maintained list — so this can't drift out of date.
  const bindings = () => router.all().filter((b) => b.label);

  return (
    <div class="scrim" onClick={props.onClose}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal__head">
          <span class="modal__title">⚙ SETTINGS</span>
          <span class="modal__sub">suite 0.1.0 · changes apply live</span>
          <button type="button" class="chip modal__close" onClick={props.onClose}>
            close <span class="chip__key">esc</span>
          </button>
        </header>

        <div class="modal__body">
          <div class="modal__col">
            <section class="group">
              <div class="panel__label">EDGE ASSIGNMENT</div>
              <p class="group__note">
                Every module renders into the same container, so any module
                works on any edge. Click to assign — the current occupant swaps
                places.
              </p>
              <For each={EDGES}>
                {(edge) => (
                  <div class="assign-row" style={{ "--accent": EDGE_HUE[edge] }}>
                    <span class="assign-row__arrow">{ARROW[edge]}</span>
                    <span class="assign-row__dir">{edge.toUpperCase()}</span>
                    <div class="assign-row__chips">
                      <For each={modules()}>
                        {(mod) => (
                          <button
                            type="button"
                            class="pick"
                            data-on={assignment()[edge] === mod.id}
                            onClick={() => assign(edge, mod.id)}
                          >
                            {mod.id}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </section>

            <div class="rule" />

            <section class="group">
              <div class="panel__label">PERFORMANCE</div>
              <Toggle
                label="Hardware acceleration"
                detail="GPU compositing for the edge swap. Off falls back to CPU."
                value={hardwareAccel()}
                onChange={setHardwareAccel}
              />
              <Toggle
                label="Panel blur"
                detail="Backdrop blur behind floating panels. The first thing to turn off if the swap stutters."
                value={panelBlur()}
                onChange={setPanelBlur}
              />
              <Toggle
                label="Bounce on swap"
                detail="Spring overshoot 1.06 · 440ms. Off is a flat 260ms ease."
                value={bounce()}
                onChange={setBounce}
              />
            </section>
          </div>

          <div class="modal__col">
            <section class="group">
              <div class="group__head">
                <span class="panel__label">HOTKEYS</span>
                <span class="group__hint">rebinding lands with the config layer</span>
              </div>
              <For each={bindings()}>
                {(b) => (
                  <div class="hotkey">
                    <span class="hotkey__label">{b.label}</span>
                    <span class="hotkey__keys">{prettyKeys(b.keys)}</span>
                  </div>
                )}
              </For>
            </section>

            <div class="rule" />

            <section class="group">
              <div class="group__head">
                <span class="panel__label">MODULES</span>
                <span class="group__hint">hot-swappable · no restart</span>
              </div>
              <For each={modules()}>
                {(mod) => (
                  <div class="mod-row">
                    <span class="mod-row__dot">●</span>
                    <span class="mod-row__name">{mod.id}</span>
                    <span class="mod-row__meta">
                      {mod.version} · {edgeOf(mod.id) ?? "unassigned"}
                    </span>
                  </div>
                )}
              </For>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
