import { onCleanup, onMount } from "solid-js";
import { focus } from "../shell/focus";

/**
 * The floating AI prompt. Not wired to a provider yet — it exists now because
 * it is the sharpest test of the focus model: typing a comma in here must not
 * open Settings, and pressing Escape must leave the field before it means
 * "go home".
 */
export function PromptPill() {
  let input!: HTMLInputElement;
  let release: (() => void) | undefined;

  onMount(() => {
    release = focus.claimText(input);
  });
  onCleanup(() => release?.());

  return (
    <div class="pill">
      <span class="pill__caret">❯</span>
      <input
        ref={input}
        class="pill__input"
        type="text"
        spellcheck={false}
        autocomplete="off"
        placeholder="summarise what changed in hypr-suite since yesterday"
        aria-label="Ask the suite"
      />
      <span class="pill__keys">⏎ run · ⇥ scope</span>
    </div>
  );
}
