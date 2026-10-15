import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ModuleContext, Project } from "@suite/module";

const TREES: Record<string, string[]> = {
  "/work/alpha": ["src", "README.md"],
  "/work/beta": ["lib", "main.rs", "Cargo.toml"],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, string>) => {
    if (cmd === "fs_list") {
      const names = TREES[args.path];
      if (!names) throw new Error("no such dir");
      return names.map((name) => ({
        name,
        path: `${args.path}/${name}`,
        dir: !name.includes("."),
        size: 1,
        modified: 0,
        hidden: false,
      }));
    }
    if (cmd === "fs_read") return { text: "", lines: 0, bytes: 0, textual: true };
    return "";
  }),
}));

import { explorerModule } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));

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

describe("explorer follows the active project", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("lists the new root after a switch", async () => {
    const [project, setProject] = createSignal<Project | null>({
      id: "/work/alpha",
      name: "alpha",
      path: "/work/alpha",
    });

    await createRoot(async (dispose) => {
      const mod = explorerModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      expect(mod.status().home).toBe("alpha · 2 items");
      expect(host.textContent).toContain("README.md");

      setProject({ id: "/work/beta", name: "beta", path: "/work/beta" });
      for (let i = 0; i < 5; i++) await tick();
      expect(mod.status().home).toBe("beta · 3 items");
      expect(host.textContent).toContain("Cargo.toml");
      expect(host.textContent).not.toContain("README.md");

      await mod.unmount();
      dispose();
    });
  });
});
