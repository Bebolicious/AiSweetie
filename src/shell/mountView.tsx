import { ErrorBoundary, type JSX } from "solid-js";
import { render } from "solid-js/web";

/**
 * How a module gets its view onto the screen.
 *
 * The reason this is not just `render()` is error containment. A module calls
 * `render()` inside its own `mount()`, which creates a **separate reactive
 * root** — so an `<ErrorBoundary>` in `ModuleFrame` cannot see anything that
 * throws inside it. The boundary has to be inside the module's own root, which
 * means either every module author remembers to add one, or the shell owns the
 * call that creates the root. This is the second option.
 *
 * What it buys: a module that throws while rendering loses its own cell and
 * nothing else. The header, the rails, the arrow keys and the other three
 * modules keep working. Without it, one uncaught error in one module's update
 * takes the whole webview to a blank screen — with every live PTY attached to
 * it. For an app whose premise is that you never leave it, "the shell is gone
 * but your shells are still running" is the failure that matters.
 *
 * This is deliberately *not* the doctor layer (architecture §11, ROADMAP 0.2).
 * That handles a dependency being legitimately absent, which is expected and
 * has a fix to offer. This handles a bug, which has neither.
 */
/** Argument order matches `render`, so it is a drop-in replacement. */
export function mountView(
  view: () => JSX.Element,
  container: HTMLElement,
): () => void {
  return render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown, reset: () => void) => (
          <ViewCrashed err={err} reset={reset} />
        )}
      >
        {view()}
      </ErrorBoundary>
    ),
    container,
  );
}

function ViewCrashed(props: { err: unknown; reset: () => void }) {
  // The console still gets the real error with its stack; the panel gets the
  // message, because a stack trace in a 22px-padded panel helps nobody.
  console.error("[module] view crashed:", props.err);

  const message = () => {
    const e = props.err;
    if (e instanceof Error) return e.message;
    return String(e);
  };

  return (
    <div class="panel empty-state">
      <div class="panel__label">THIS MODULE CRASHED</div>
      <p>
        Something threw while rendering. The rest of the suite is unaffected —
        the other edges, the rails and <code>esc</code> all still work.
      </p>
      <p>
        <code>{message()}</code>
      </p>
      <button type="button" class="chip" onClick={props.reset}>
        try again
      </button>
    </div>
  );
}
