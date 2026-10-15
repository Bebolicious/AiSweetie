import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ModuleContext, Project } from "@suite/module";

// A fake host: two repositories, each answering with its own branch.
const REPOS: Record<string, { branch: string; changed: number }> = {
  "/work/alpha": { branch: "main", changed: 2 },
  "/work/beta": { branch: "feat/edges", changed: 0 },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, string>) => {
    switch (cmd) {
      case "git_root":
        if (!(args.start in REPOS)) throw new Error("not a repo");
        return args.start;
      case "git_status": {
        const r = REPOS[args.repo];
        const files = Array.from({ length: r.changed }, (_, i) => ({
          path: `f${i}.ts`,
          status: "M",
          added: 1,
          removed: 0,
        }));
        return { root: args.repo, branch: r.branch, ahead: 0, behind: 0, staged: [], unstaged: files };
      }
      case "git_branches":
        return [];
      case "git_log":
        return [];
      default:
        return "";
    }
  }),
}));

import { gitModule } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));

function ctxWith(project: () => Project | null): ModuleContext {
  return {
    edge: () => "top",
    accent: () => "",
    project,
    bus: { emit() {}, on: () => () => {} },
    focus: { claimText: () => () => {}, hasTextFocus: () => false },
    nav: { home() {}, toEdge() {} },
  };
}

describe("git follows the active project", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("re-resolves the repository and status when the project switches", async () => {
    const [project, setProject] = createSignal<Project | null>({
      id: "/work/alpha",
      name: "alpha",
      path: "/work/alpha",
    });

    await createRoot(async (dispose) => {
      const mod = gitModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctxWith(project));
      for (let i = 0; i < 5; i++) await tick();
      expect(mod.status().header).toBe("main · 2 changed");

      setProject({ id: "/work/beta", name: "beta", path: "/work/beta" });
      for (let i = 0; i < 5; i++) await tick();
      expect(mod.status().header).toBe("feat/edges · 0 changed");

      setProject({ id: "/tmp/none", name: "none", path: "/tmp/none" });
      for (let i = 0; i < 5; i++) await tick();
      expect(mod.status().header).toBe("no repository");
      expect(host.textContent).toContain("/tmp/none");

      await mod.unmount();
      dispose();
    });
  });
});
