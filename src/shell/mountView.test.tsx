import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { mountView } from "./mountView";

/**
 * The property under test is containment, not the wording of the panel: a
 * module that throws must lose its own cell and nothing else.
 */
describe("mountView", () => {
  it("renders a view normally", () => {
    const host = document.createElement("div");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const dispose = mountView(() => <p>alive</p>, host);

    expect(host.textContent).toContain("alive");
    expect(spy).not.toHaveBeenCalled();

    dispose();
    spy.mockRestore();
  });

  it("contains a throw during the initial render", () => {
    const host = document.createElement("div");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Without the boundary this throw escapes `render()` and takes down
    // whatever called it — in the real app, the shell.
    const dispose = mountView(() => {
      throw new Error("module is broken");
    }, host);

    expect(host.textContent).toContain("THIS MODULE CRASHED");
    expect(host.textContent).toContain("module is broken");
    expect(spy).toHaveBeenCalled();

    dispose();
    spy.mockRestore();
  });

  it("contains a throw from a later reactive update", () => {
    const host = document.createElement("div");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [boom, setBoom] = createSignal(false);

    const view = () => (
      <p>
        {(() => {
          if (boom()) throw new Error("threw on update");
          return "fine";
        })()}
      </p>
    );

    const dispose = mountView(view, host);
    expect(host.textContent).toContain("fine");

    // The case `ModuleFrame`'s try/catch cannot reach: mount already returned
    // cleanly and the failure arrives later, with a signal change.
    setBoom(true);
    expect(host.textContent).toContain("THIS MODULE CRASHED");
    expect(host.textContent).toContain("threw on update");

    dispose();
    spy.mockRestore();
  });

  it("leaves a sibling view untouched when one crashes", () => {
    const good = document.createElement("div");
    const bad = document.createElement("div");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const disposeGood = mountView(() => <p>still here</p>, good);
    const disposeBad = mountView(() => {
      throw new Error("down");
    }, bad);

    expect(bad.textContent).toContain("THIS MODULE CRASHED");
    expect(good.textContent).toBe("still here");

    disposeGood();
    disposeBad();
    spy.mockRestore();
  });
});
