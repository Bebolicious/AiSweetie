import { describe, expect, it, beforeEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { assign, assignment, edgeOf } from "./edges";
import { createRouter, chord } from "./keymap";
import { focus } from "./focus";
import { GRID, trackTransform, cellPosition, BACK_FROM } from "./track";
import { createBus } from "./bus";
import { Settings } from "./Settings";
import { hardwareAccel, panelBlur, bounce } from "./prefs";
import { registerBuiltins } from "../modules";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, cancelable: true });
}

describe("track geometry", () => {
  it("puts home at the centre of the 3×3 world", () => {
    expect(trackTransform(GRID.home)).toBe(
      "translate3d(-33.333333333333336%, -33.333333333333336%, 0)",
    );
  });

  it("parks each module one cell out in its own direction", () => {
    expect(cellPosition(GRID.top).top).toBe("0%");
    expect(cellPosition(GRID.bottom).top).toBe("66.66666666666667%");
    expect(cellPosition(GRID.left).left).toBe("0%");
    expect(cellPosition(GRID.right).left).toBe("66.66666666666667%");
  });

  it("knows which arrow points back at home from each edge", () => {
    expect(BACK_FROM.top).toBe("bottom");
    expect(BACK_FROM.right).toBe("left");
  });
});

describe("edge assignment", () => {
  it("swaps the two modules when assigning one that already holds an edge", () => {
    // Defaults: top=git, right=terminal.
    expect(assignment().top).toBe("git");
    expect(assignment().right).toBe("terminal");

    assign("top", "terminal");

    expect(assignment().top).toBe("terminal");
    // git did not vanish — it took terminal's old edge.
    expect(assignment().right).toBe("git");
    expect(edgeOf("git")).toBe("right");
  });

  it("is a no-op when the module is already on that edge", () => {
    const before = { ...assignment() };
    assign("bottom", assignment().bottom);
    expect(assignment()).toEqual(before);
  });
});

describe("chord normalization", () => {
  it("maps arrows and space to stable names", () => {
    expect(chord(key({ key: "ArrowUp" }))).toBe("up");
    expect(chord(key({ key: " " }))).toBe("space");
  });

  it("uses a platform-neutral 'mod' so config stays portable", () => {
    // happy-dom reports a non-Mac UA, so mod is Ctrl here.
    expect(chord(key({ key: "q", ctrlKey: true }))).toBe("mod+q");
  });
});

describe("the global focus model", () => {
  let router: ReturnType<typeof createRouter>;
  let fired: string[];

  beforeEach(() => {
    document.body.innerHTML = "";
    fired = [];
    router = createRouter();
    router.register([
      { id: "t.comma", keys: ",", label: "Settings", run: () => fired.push(",") },
      { id: "t.quit", keys: "mod+q", label: "Quit", run: () => fired.push("mod+q") },
      { id: "t.esc", keys: "escape", label: "Home", run: () => fired.push("escape") },
    ]);
  });

  it("routes a bare key as a command when nothing is taking text", () => {
    router.handle(key({ key: "," }));
    expect(fired).toEqual([","]);
  });

  it("does NOT route a bare key while a text surface has focus", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(focus.hasTextFocus()).toBe(true);

    router.handle(key({ key: "," }));

    // This is the whole point: a comma typed into the prompt is a comma.
    expect(fired).toEqual([]);
  });

  it("still routes a modified chord while text has focus", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    router.handle(key({ key: "q", ctrlKey: true }));

    expect(fired).toEqual(["mod+q"]);
  });

  it("lets escape leave the text surface before it means 'go home'", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    router.handle(key({ key: "Escape" }));
    expect(fired).toEqual([]); // consumed by the blur
    expect(focus.hasTextFocus()).toBe(false);

    router.handle(key({ key: "Escape" }));
    expect(fired).toEqual(["escape"]); // now it navigates
  });

  it("ignores a checkbox, which is an input but takes no text", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.append(box);
    box.focus();
    expect(focus.hasTextFocus()).toBe(false);
  });
});

describe("the message bus", () => {
  it("delivers to subscribers and survives a throwing handler", () => {
    const bus = createBus();
    const seen: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.on("file.open", () => {
      throw new Error("boom");
    });
    bus.on("file.open", (p) => seen.push(p.path));

    bus.emit("file.open", { path: "diff.rs" });

    expect(seen).toEqual(["diff.rs"]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createBus();
    const seen: string[] = [];
    const off = bus.on("git.stage", (p) => seen.push(p.path));
    bus.emit("git.stage", { path: "a" });
    off();
    bus.emit("git.stage", { path: "b" });
    expect(seen).toEqual(["a"]);
  });
});

describe("Settings performance toggles", () => {
  it("renders every toggle in its actual default state", () => {
    registerBuiltins();
    const { getAllByRole } = render(() => <Settings onClose={() => {}} />);

    const switches = getAllByRole("switch");
    const state = Object.fromEntries(
      switches.map((s) => [
        s.getAttribute("aria-label"),
        s.getAttribute("data-on"),
      ]),
    );

    expect(state["Hardware acceleration"]).toBe(String(hardwareAccel()));
    expect(state["Panel blur"]).toBe(String(panelBlur()));
    expect(state["Bounce on swap"]).toBe(String(bounce()));

    // All three default on; a toggle rendering off here is a real defect.
    expect(state["Hardware acceleration"]).toBe("true");
  });
});
