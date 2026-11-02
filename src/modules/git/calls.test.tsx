import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ModuleContext, Project } from "@suite/module";

/** Every host command the module issues, in order. */
const calls: string[] = [];
/** Whether each branches/log call asked the host to bypass its cache. */
const freshFlags: { cmd: string; fresh: unknown }[] = [];

const REPOS = ["/work/alpha", "/work/beta"];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, string>) => {
    calls.push(cmd);
    switch (cmd) {
      case "git_root":
        if (!REPOS.includes(args.start)) throw new Error("not a repo");
        return args.start;
      case "git_status":
        return {
          root: args.repo,
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [{ path: "a.ts", status: "M", added: 1, removed: 0 }],
        };
      case "git_branches":
      case "git_log":
        freshFlags.push({ cmd, fresh: args.fresh });
        return [];
      case "git_diff":
        return "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n";
      default:
        return "";
    }
  }),
}));

import { gitModule } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

function ctx(project: () => Project | null): ModuleContext {
  return {
    edge: () => "top",
    accent: () => "",
    project,
    bus: { emit() {}, on: () => () => {} },
    focus: { claimText: () => () => {}, hasTextFocus: () => false },
    nav: { home() {}, toEdge() {} },
  };
}

const count = (cmd: string) => calls.filter((c) => c === cmd).length;

describe("git host call pattern", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
    calls.length = 0;
    freshFlags.length = 0;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  /**
   * Establishes whether there is anything for a cache to absorb. `git_status`
   * is three subprocesses at ~33 ms, so repetition is what would justify
   * caching it — and the module does not poll, so this counts what a realistic
   * session actually issues.
   */
  it("counts host calls across a realistic session", async () => {
    const [project, setProject] = createSignal<Project | null>({
      id: "/work/alpha",
      name: "alpha",
      path: "/work/alpha",
    });

    await createRoot(async (dispose) => {
      const mod = gitModule();
      const host = document.createElement("div");
      document.body.append(host);

      await mod.mount(host, ctx(project));
      await settle();
      const atMount = { ...snapshot() };

      setProject({ id: "/work/beta", name: "beta", path: "/work/beta" });
      await settle();
      const afterSwitch = { ...snapshot() };

      setProject({ id: "/work/alpha", name: "alpha", path: "/work/alpha" });
      await settle();
      const afterSwitchBack = { ...snapshot() };

      // `r` — the explicit refresh binding.
      mod.keymap().find((b) => b.id === "git.refresh")!.run();
      await settle();
      const afterRefresh = { ...snapshot() };

      console.log(
        `\n  phase            root status branches log diff\n` +
          `  mount            ${row(atMount)}\n` +
          `  switch to beta   ${row(afterSwitch)}\n` +
          `  switch back      ${row(afterSwitchBack)}\n` +
          `  press r          ${row(afterRefresh)}\n` +
          `  TOTAL git_status calls: ${count("git_status")}`,
      );

      // Four events: mount, two switches, one refresh. Every command should
      // fire exactly once per event — each is a ~12 ms process spawn
      // (git_status is three), so a redundant call is a dropped frame's worth
      // of work for an answer nobody asked to change.
      //
      // `git_diff` is the one that regressed before: `autoSelect` returned a
      // fresh object and the resource key a fresh array, so it refetched on
      // any upstream movement and ran 7 times instead of 4.
      expect(count("git_status")).toBe(4);
      expect(count("git_diff")).toBe(4);
      expect(count("git_root")).toBe(4);
      expect(count("git_branches")).toBe(4);
      expect(count("git_log")).toBe(4);

      // Branches and the log are cached host-side against a fingerprint of
      // the refs, so what matters here is *which* calls ask to bypass it.
      // Only the explicit `r` may: everything else either cannot have moved a
      // ref, or is a fresh repository the cache has never seen.
      const fresh = freshFlags.filter((f) => f.fresh === true);
      expect(fresh).toHaveLength(2); // git_branches and git_log, once each
      expect(fresh.map((f) => f.cmd).sort()).toEqual([
        "git_branches",
        "git_log",
      ]);

      await mod.unmount();
      dispose();
    });
  });

  /**
   * The case the host-side cache exists for.
   *
   * Staging rewrites the index. It cannot move a ref, so the branch list and
   * the commit log are still correct — but `reload()` refetches all three
   * resources, which used to mean two `git` spawns for answers that had not
   * changed. Staging must therefore *not* ask to bypass the cache, while the
   * status it genuinely invalidates is refetched as always.
   */
  it("staging does not ask the host for fresh branches or log", async () => {
    const [project] = createSignal<Project | null>({
      id: "/work/alpha",
      name: "alpha",
      path: "/work/alpha",
    });

    await createRoot(async (dispose) => {
      const mod = gitModule();
      const host = document.createElement("div");
      document.body.append(host);
      await mod.mount(host, ctx(project));
      await settle();

      const statusBefore = count("git_status");
      freshFlags.length = 0;

      // `space` — stage the hunk under the cursor, then reload.
      mod.keymap().find((b) => b.id === "git.stageHunk")!.run();
      await settle();

      expect(count("git_status")).toBeGreaterThan(statusBefore);
      expect(freshFlags.length).toBeGreaterThan(0);
      expect(freshFlags.every((f) => f.fresh === false)).toBe(true);

      await mod.unmount();
      dispose();
    });
  });
});

function snapshot() {
  return {
    root: count("git_root"),
    status: count("git_status"),
    branches: count("git_branches"),
    log: count("git_log"),
    diff: count("git_diff"),
  };
}

function row(s: ReturnType<typeof snapshot>) {
  return `${String(s.root).padStart(4)} ${String(s.status).padStart(6)} ${String(
    s.branches,
  ).padStart(8)} ${String(s.log).padStart(3)} ${String(s.diff).padStart(4)}`;
}
