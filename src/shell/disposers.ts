/**
 * Holding disposers that are acquired asynchronously.
 *
 * Subscribing to a Tauri event returns a *promise* of the unsubscribe
 * function, which opens a race that is easy to write and hard to see:
 *
 * ```ts
 * let unlisten: UnlistenFn | undefined;
 * void (async () => { unlisten = await listen("x", fn); })();
 * onCleanup(() => unlisten?.());   // still undefined if we got here first
 * ```
 *
 * Unmount before the promise settles and cleanup finds `undefined`, then the
 * assignment lands afterwards on nobody — the listener is registered forever,
 * still firing into a disposed reactive scope. It survives every unmount, so
 * the leak is per mount/unmount cycle, and `registry.reload()` (ROADMAP 0.3)
 * is about to make that cycle routine for every module.
 *
 * This is the invariant written down once instead: a disposer that arrives
 * after disposal is disposed immediately rather than kept.
 */

export interface Disposers {
  /**
   * Await an acquisition and hold its disposer — unless disposal already
   * happened, in which case run the disposer now and keep nothing.
   */
  add(acquire: Promise<() => void>): Promise<void>;
  /** Whether `dispose()` has run. Guards work that should not start. */
  readonly disposed: boolean;
  /** Run every held disposer. Safe to call more than once. */
  dispose(): void;
}

export function createDisposers(): Disposers {
  let disposed = false;
  const held: (() => void)[] = [];

  return {
    async add(acquire) {
      const dispose = await acquire;
      if (disposed) {
        dispose();
        return;
      }
      held.push(dispose);
    },

    get disposed() {
      return disposed;
    },

    dispose() {
      disposed = true;
      // splice so a second call is a no-op rather than a double-dispose.
      for (const d of held.splice(0)) {
        try {
          d();
        } catch (err) {
          console.error("[disposers] a disposer threw:", err);
        }
      }
    },
  };
}
