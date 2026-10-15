import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { focus } from "../shell/focus";
import { home, listDirs } from "../shell/host";
import { get } from "../shell/registry";
import { useStatus } from "../shell/useStatus";
import { tailSegments } from "../shell/paths";
import { activeProject, openProject, recentProjects } from "../shell/project";

const SUGGESTIONS = 8;

/** "/home/alex/Pro" → parent "/home/alex/", partial "Pro". */
function splitTyped(typed: string): { parent: string; partial: string } {
  const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"));
  if (cut === -1) return { parent: "", partial: typed };
  return { parent: typed.slice(0, cut + 1), partial: typed.slice(cut + 1) };
}

/**
 * The project switcher.
 *
 * An in-app picker rather than the OS folder dialog: a GTK file chooser is a
 * foreign, mouse-first window floating over a fullscreen app whose premise is
 * no window chrome. This one is a path with Tab completion, which is how a
 * developer already thinks about a directory.
 */
export function Projects(props: {
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
}) {
  const gitStatus = useStatus(() => get("git"));

  const [typed, setTyped] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let release: (() => void) | undefined;

  const [homeDir] = createResource(() => home());

  const expand = (p: string) => {
    const h = homeDir();
    return h && (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))
      ? h + p.slice(1)
      : p;
  };

  // Suggestions come from listing the parent of what is typed. The listing
  // is keyed on the parent only, so typing within one directory does not
  // hit the disk per keystroke.
  const [siblings] = createResource(
    () => (props.pickerOpen ? splitTyped(expand(typed())).parent || null : null),
    async (parent) => {
      try {
        return await listDirs(parent);
      } catch {
        return [];
      }
    },
  );

  const suggestions = () => {
    const { partial } = splitTyped(expand(typed()));
    const q = partial.toLowerCase();
    return (siblings() ?? [])
      .filter((name) => (q.startsWith(".") ? true : !name.startsWith(".")))
      .filter((name) => name.toLowerCase().startsWith(q))
      .slice(0, SUGGESTIONS);
  };

  createEffect(on(suggestions, () => setHighlight(0)));

  // Opening the picker starts from the active project's parent, so sibling
  // projects — the common case when you swap a lot — are one Tab away.
  createEffect(
    on(
      () => props.pickerOpen,
      (open) => {
        if (!open) return;
        const current = activeProject()?.path ?? "";
        const { parent } = splitTyped(current);
        setTyped(parent || (current ? current + "/" : ""));
        queueMicrotask(() => {
          input?.focus();
          input?.select();
          input?.setSelectionRange(input.value.length, input.value.length);
        });
      },
    ),
  );

  createEffect(() => {
    if (!input) return;
    release = focus.claimText(input);
    onCleanup(() => release?.());
  });

  function complete() {
    const pick = suggestions()[highlight()];
    if (!pick) return;
    const { parent } = splitTyped(expand(typed()));
    const sep = parent.includes("\\") ? "\\" : "/";
    setTyped(parent + pick + sep);
  }

  async function submit() {
    const path = expand(typed()).trim();
    if (!path) return;
    try {
      await listDirs(path); // rejects unless this is a readable directory
    } catch {
      complete(); // not a directory yet — treat Enter as "take the suggestion"
      return;
    }
    openProject(path);
    // Blur rather than close directly: a hidden-but-focused input would keep
    // the focus model treating every bare key as typing. Blur closes it.
    input?.blur();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Tab") {
      e.preventDefault();
      complete();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, suggestions().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    }
    // Escape is the shell's: it blurs the field, and blur closes the picker.
  }

  return (
    <div class="panel projects" style={{ "--accent": "var(--teal)" }}>
      <div class="projects__head">
        <span class="panel__label">PROJECTS</span>
        <Show when={!props.pickerOpen}>
          <button
            type="button"
            class="chip"
            onClick={() => props.onOpenPicker()}
            aria-label="Open a project"
          >
            open <span class="chip__key">o</span>
          </button>
        </Show>
      </div>

      <div class="proj-pick" data-open={props.pickerOpen ? "true" : "false"}>
        <span class="proj-pick__caret">❯</span>
        <input
          ref={input}
          class="proj-pick__input"
          type="text"
          spellcheck={false}
          autocomplete="off"
          placeholder="path to a project directory"
          aria-label="Project path"
          value={typed()}
          onInput={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={onKey}
          onBlur={() => props.onClosePicker()}
        />
        <span class="proj-pick__keys">⇥ complete · ⏎ open</span>
      </div>

      <Show when={props.pickerOpen && suggestions().length > 0}>
        <div class="proj-sug">
          <For each={suggestions()}>
            {(name, i) => (
              <button
                type="button"
                class="proj-sug__item"
                data-on={i() === highlight() ? "true" : "false"}
                // mousedown, not click: click fires after the input blurs and
                // the picker would already be gone.
                onMouseDown={(e) => {
                  e.preventDefault();
                  setHighlight(i());
                  complete();
                }}
              >
                {name}/
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={recentProjects().length > 0}
        fallback={<p class="muted">no project yet — run under the Tauri host</p>}
      >
        <div class="proj-list">
          <For each={recentProjects()}>
            {(p) => {
              const active = () => activeProject()?.id === p.id;
              return (
                <button
                  type="button"
                  class="proj-row"
                  data-on={active() ? "true" : "false"}
                  onClick={() => openProject(p.path)}
                  title={p.path}
                >
                  <span class="proj-row__mark">{active() ? "◆" : "◇"}</span>
                  <span class="proj-row__name">{p.name}</span>
                  <span class="proj-row__path">{tailSegments(p.path, 2)}</span>
                  <span class="proj-row__status">
                    {active() ? gitStatus().home : ""}
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
