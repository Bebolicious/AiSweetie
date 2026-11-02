import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { ModuleContext, Project } from "@suite/module";

/**
 * How large a diff the fake host serves. Set per test.
 */
const shape = { hunks: 1, linesPerHunk: 10 };

/** A synthetic unified diff of a given shape. */
function makeDiff(hunks: number, linesPerHunk: number): string {
  const out = ["--- a/big.txt", "+++ b/big.txt"];
  for (let h = 0; h < hunks; h++) {
    const start = h * (linesPerHunk + 20) + 1;
    out.push(`@@ -${start},${linesPerHunk} +${start},${linesPerHunk} @@`);
    for (let l = 0; l < linesPerHunk; l++) {
      out.push(l % 2 === 0 ? `-old line ${h}.${l}` : `+new line ${h}.${l}`);
    }
  }
  return out.join("\n") + "\n";
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "git_root":
        return "/repo";
      case "git_status":
        return {
          root: "/repo",
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [{ path: "big.txt", status: "M", added: 1, removed: 1 }],
        };
      case "git_branches":
      case "git_log":
        return [];
      case "git_diff":
        return makeDiff(shape.hunks, shape.linesPerHunk);
      default:
        return "";
    }
  }),
}));

import { gitModule } from "./index";

const tick = () => new Promise((r) => setTimeout(r, 0));

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

async function mountWith(hunks: number, linesPerHunk: number) {
  shape.hunks = hunks;
  shape.linesPerHunk = linesPerHunk;

  const host = document.createElement("div");
  document.body.append(host);
  const mod = gitModule();
  const [project] = createSignal<Project | null>({
    id: "/repo",
    name: "repo",
    path: "/repo",
  });

  let dispose!: () => void;
  await createRoot(async (d) => {
    dispose = d;
    await mod.mount(host, ctx(project));
    for (let i = 0; i < 8; i++) await tick();
  });

  return {
    host,
    rows: host.querySelectorAll(".dl").length,
    folded: host.querySelectorAll(".hunk__fold").length,
    more: host.querySelectorAll(".hunk__more").length,
    total: hunks * linesPerHunk,
    async teardown() {
      await mod.unmount();
      dispose();
    },
  };
}

describe("git diff render size", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  /**
   * Before the caps, the rendered row count *was* the diff's line count —
   * every line of every hunk, unconditionally. So `total` below is not an
   * estimate of the old behaviour, it is exactly what the old code rendered.
   */
  it("renders a small diff in full, unchanged", async () => {
    const r = await mountWith(4, 20); // 80 lines, under EXPAND_BUDGET
    console.log(
      `  small   ${r.total} line diff → ${r.rows} rows rendered (no caps applied)`,
    );
    expect(r.rows).toBe(r.total);
    expect(r.more).toBe(0);
    await r.teardown();
  });

  it("collapses unfocused hunks once the diff is large", async () => {
    const r = await mountWith(50, 100); // 5000 lines
    console.log(
      `  many    ${r.total} line diff → ${r.rows} rows + ${r.folded} folded headers ` +
        `(was ${r.total}, ${(r.total / Math.max(r.rows, 1)).toFixed(0)}x fewer)`,
    );
    // Only the focused hunk's lines, plus a folded summary for each other.
    expect(r.rows).toBe(100);
    expect(r.folded).toBe(49);
    await r.teardown();
  });

  it("caps one enormous hunk and offers the rest", async () => {
    const r = await mountWith(1, 5000); // one giant hunk
    console.log(
      `  giant   ${r.total} line diff → ${r.rows} rows ` +
        `(was ${r.total}, ${(r.total / Math.max(r.rows, 1)).toFixed(0)}x fewer) ` +
        `+ ${r.more} expander`,
    );
    expect(r.rows).toBe(600); // LINE_CAP
    // The remainder must be reachable, not discarded — that was the defect.
    expect(r.more).toBe(1);
    expect(r.host.textContent).toContain("remaining 4400 lines");
    await r.teardown();
  });
});
