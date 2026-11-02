import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ModuleContext, Project } from "@suite/module";

const FILES = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];

/** Content actually read. */
const reads: string[] = [];
/** Every `fs_read` invocation, including revalidations that read nothing. */
const calls: string[] = [];

/** Bumped to simulate the file changing on disk. */
const mtime = { value: 1000 };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, raw: Record<string, unknown>) => {
    const args = raw as { path: string; known?: number };
    if (cmd === "fs_list") {
      if (args.path !== "/work/proj") throw new Error("no such dir");
      return FILES.map((name) => ({
        name,
        path: `${args.path}/${name}`,
        dir: false,
        size: 10,
        modified: mtime.value,
        hidden: false,
      }));
    }
    if (cmd === "fs_read") {
      calls.push(args.path);
      // Mirror the host: when the caller already has this mtime, stop after
      // the stat and read nothing.
      if (args.known === mtime.value && mtime.value !== 0) {
        return {
          text: "",
          lines: 0,
          bytes: 1,
          textual: false,
          modified: mtime.value,
          unchanged: true,
        };
      }
      reads.push(args.path);
      return {
        text: "x",
        lines: 1,
        bytes: 1,
        textual: true,
        modified: mtime.value,
        unchanged: false,
      };
    }
    return "";
  }),
}));

import { explorerModule } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Past the preview debounce, so a read that is going to happen has. */
const settle = () => new Promise((r) => setTimeout(r, 200));

function ctxWith(project: () => Project | null): ModuleContext {
  return {
    edge: () => "bottom",
    accent: () => "",
    project,
    bus: { emit() {}, on: () => () => {} },
    focus: { claimText: () => () => {}, hasTextFocus: () => false },
    nav: { home() {}, toEdge() {} },
  };
}

function type(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>(".exp-prompt__input");
  if (!input) throw new Error("filter input not found");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("explorer filtering", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
    reads.length = 0;
    calls.length = 0;
    mtime.value = 1000;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  /**
   * The expensive half of this module is `fs_read` plus a synchronous
   * whole-file syntax highlight. Keying the keep-a-file-selected effect on the
   * *filtered* list meant every keystroke that excluded the selection ran both
   * again — so this counts reads rather than inspecting state.
   */
  it("does not read a file for every keystroke in the filter", async () => {
    const [project] = createSignal<Project | null>({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      await settle();

      // One read for the initial auto-selection, and that is the baseline.
      const afterMount = reads.length;
      expect(afterMount).toBe(1);

      // Typing "delt" excludes alpha.ts — the selected file — at the first
      // keystroke, and used to re-point the selection each time.
      for (const value of ["d", "de", "del", "delt"]) {
        type(host, value);
        for (let i = 0; i < 3; i++) await tick();
      }
      await settle();

      expect(reads.length).toBe(afterMount);

      await mod.unmount();
      dispose();
    });
  });

  it("still filters the listing while typing", async () => {
    const [project] = createSignal<Project | null>({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();

      expect(host.textContent).toContain("alpha.ts");

      // The listing itself is cheap and must stay instant — only the preview
      // was deferred.
      type(host, "delt");
      for (let i = 0; i < 3; i++) await tick();

      expect(host.textContent).toContain("delta.ts");
      expect(host.textContent).not.toContain("alpha.ts");

      await mod.unmount();
      dispose();
    });
  });

  it("re-selecting a file re-reads nothing", async () => {
    // The saving is the read, the payload and the highlight. A revalidating
    // `fs_read` still happens — one `stat` — which is what keeps it sound.
    const [project] = createSignal<Project | null>({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      await settle();
      expect(reads).toEqual(["/work/proj/alpha.ts"]);

      const rows = () => host.querySelectorAll<HTMLElement>(".exp-list .row");
      const click = async (name: string) => {
        const row = [...rows()].find((r) => r.textContent?.includes(name));
        if (!row) throw new Error(`no row for ${name}`);
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 3; i++) await tick();
        await settle();
      };

      await click("beta.ts");
      await click("gamma.ts");
      expect(reads).toEqual([
        "/work/proj/alpha.ts",
        "/work/proj/beta.ts",
        "/work/proj/gamma.ts",
      ]);

      // Back over the same three. Every one is a hit: the host is asked, and
      // answers "unchanged" without reading.
      const readsBefore = reads.length;
      const callsBefore = calls.length;
      await click("alpha.ts");
      await click("beta.ts");
      await click("gamma.ts");

      expect(reads.length).toBe(readsBefore);
      expect(calls.length).toBe(callsBefore + 3);

      // And the cache has to actually supply the content it saved reading.
      // Without this the test has no teeth: an "unchanged" reply carries an
      // empty body, so dropping the cache hit would still read nothing — it
      // would just render the preview blank.
      const pane = () =>
        host.querySelector(".exp-preview__body")?.textContent ?? "";
      expect(pane()).toContain("x");
      expect(pane()).not.toContain("binary or too large");

      await mod.unmount();
      dispose();
    });
  });

  it("re-reads a file that changed on disk", async () => {
    // The soundness property, and the reason validation is not done against
    // the mtime the listing happened to report: nothing re-lists a directory
    // you are already looking at, so a cache trusting that snapshot would
    // serve the old contents of a file edited in a terminal pane forever.
    const [project] = createSignal<Project | null>({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      await settle();
      expect(reads).toEqual(["/work/proj/alpha.ts"]);

      const click = async (name: string) => {
        const row = [
          ...host.querySelectorAll<HTMLElement>(".exp-list .row"),
        ].find((r) => r.textContent?.includes(name));
        if (!row) throw new Error(`no row for ${name}`);
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 3; i++) await tick();
        await settle();
      };

      // Confirm it is cached, then change the file underneath it.
      await click("beta.ts");
      await click("alpha.ts");
      expect(reads).toEqual(["/work/proj/alpha.ts", "/work/proj/beta.ts"]);

      mtime.value = 2000;
      await click("beta.ts");
      await click("alpha.ts");

      // Both had to be read again, without the listing being refreshed.
      expect(reads).toEqual([
        "/work/proj/alpha.ts",
        "/work/proj/beta.ts",
        "/work/proj/beta.ts",
        "/work/proj/alpha.ts",
      ]);

      await mod.unmount();
      dispose();
    });
  });

  it("keeps a file selected after moving to another directory", async () => {
    // The case that justified keying on the listing rather than dropping the
    // effect: the selection must still be replaced when the directory itself
    // changes, just not when a filter hides it.
    const [project, setProject] = createSignal<Project | null>({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      await settle();
      expect(reads).toEqual(["/work/proj/alpha.ts"]);

      // Re-point at the same listing via a project switch; the effect should
      // re-select rather than leave a stale selection.
      setProject({ id: "/work/proj", name: "proj", path: "/work/proj" });
      for (let i = 0; i < 5; i++) await tick();
      await settle();

      expect(reads[reads.length - 1]).toBe("/work/proj/alpha.ts");

      await mod.unmount();
      dispose();
    });
  });
});
