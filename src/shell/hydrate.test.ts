import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, assignment, collectEdges, hydrateEdges } from "./edges";
import {
  bounce,
  collectPrefs,
  hardwareAccel,
  hydratePrefs,
  panelBlur,
  setBounce,
  setHardwareAccel,
  setPanelBlur,
} from "./prefs";
import {
  activeProject,
  collectProjects,
  hydrateProjects,
  openProject,
  recentProjects,
  resetProjects,
} from "./project";
import { defaultConfig } from "./config";

const KNOWN = ["git", "terminal", "explorer", "agents"];

/**
 * ROADMAP 0.1's done-when is "hand-editing the TOML is reflected on next
 * launch". The Rust tests cover the file; these cover the other half — that a
 * loaded config actually reaches the signals the shell renders from, and that
 * a hand-written file which is *wrong* degrades instead of breaking the app.
 */
describe("hydrating from config", () => {
  beforeEach(() => {
    hydrateEdges({}, KNOWN);
    hydratePrefs(defaultConfig().performance);
    resetProjects();
  });

  describe("edges", () => {
    it("adopts a stored assignment", () => {
      hydrateEdges(
        { top: "terminal", right: "git", bottom: "agents", left: "explorer" },
        KNOWN,
      );
      expect(collectEdges()).toEqual({
        top: "terminal",
        right: "git",
        bottom: "agents",
        left: "explorer",
      });
    });

    it("keeps defaults for edges the file omits", () => {
      // A partial `[edges]` block is the common hand-edit: set one, leave
      // the rest. `terminal` is the default on `right`, so hydrating it onto
      // `top` must also push `right` off it rather than duplicate.
      hydrateEdges({ top: "terminal" }, KNOWN);
      expect(assignment().top).toBe("terminal");
      expect(assignment().bottom).toBe("explorer");
      expect(assignment().left).toBe("agents");
      expect(new Set(Object.values(collectEdges())).size).toBe(4);
    });

    /**
     * The hand-editing failure mode. An unknown id would leave the edge
     * pointing at nothing and `ModuleFrame` would render a header with an
     * empty body — indistinguishable from the HMR gap in §7, which is a
     * miserable thing to debug from the symptom.
     */
    it("rejects an unknown module id and says so", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      hydrateEdges({ top: "gti" }, KNOWN); // typo'd "git"

      expect(assignment().top).toBe("git");
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0])).toContain("gti");
      warn.mockRestore();
    });

    /**
     * Two edges holding one module makes an edge unreachable: the frame is
     * keyed to the module, so the second assignment moves the same element
     * rather than creating a new one.
     */
    it("refuses to put one module on two edges", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      hydrateEdges({ top: "git", right: "git" }, KNOWN);

      const edges = collectEdges();
      const ids = Object.values(edges);
      expect(new Set(ids).size).toBe(4);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    /**
     * The regression. A partial edit naming a module that is some *other*
     * edge's default used to leave that module on two edges and `git` on
     * none — because the dedup pass "reset" the loser to its default, which
     * was the colliding value itself. Every module must still appear exactly
     * once however partial the file is.
     */
    it("rehomes the displaced module instead of duplicating it", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      hydrateEdges({ top: "terminal" }, KNOWN); // terminal is right's default

      const edges = collectEdges();
      expect(edges.top).toBe("terminal");
      expect(Object.values(edges).sort()).toEqual(
        ["agents", "explorer", "git", "terminal"],
        // every module placed, exactly once
      );
      warn.mockRestore();
    });

    it("round-trips what the user set in the UI", () => {
      // Settings writes through `assign`; the collect/hydrate pair has to
      // preserve whatever that produced.
      assign("top", "agents");
      const saved = collectEdges();

      hydrateEdges({}, KNOWN); // simulate a restart on defaults
      expect(collectEdges().top).toBe("git");

      hydrateEdges(saved, KNOWN);
      expect(collectEdges()).toEqual(saved);
    });
  });

  describe("performance toggles", () => {
    it("adopts stored toggles", () => {
      hydratePrefs({ hardware_accel: false, panel_blur: false, bounce: false });
      expect(hardwareAccel()).toBe(false);
      expect(panelBlur()).toBe(false);
      expect(bounce()).toBe(false);
    });

    /**
     * `false` is the whole point of these toggles — `stored.panel_blur || true`
     * would silently ignore the one setting a Linux user is most likely to have
     * turned off.
     */
    it("treats a stored false as a value, not as absent", () => {
      hydratePrefs({ panel_blur: false });
      expect(panelBlur()).toBe(false);
      expect(bounce()).toBe(true); // omitted, so unchanged
    });

    it("round-trips", () => {
      setHardwareAccel(false);
      setPanelBlur(true);
      setBounce(false);
      const saved = collectPrefs();

      hydratePrefs({ hardware_accel: true, panel_blur: true, bounce: true });
      hydratePrefs(saved);

      expect(collectPrefs()).toEqual(saved);
    });
  });

  describe("projects", () => {
    it("restores the recents list and makes the newest active", () => {
      const restored = hydrateProjects([
        { name: "aisweete", path: "/work/aisweete", self_dev: true },
        { name: "other", path: "/work/other", self_dev: false },
      ]);

      expect(restored).toBe(true);
      expect(recentProjects()).toHaveLength(2);
      expect(activeProject()?.path).toBe("/work/aisweete");
      expect(activeProject()?.selfDev).toBe(true);
    });

    it("reports nothing restored for an empty list, so boot can fall back", () => {
      // This is what tells `bootProject` it may seed from `fs_cwd`.
      expect(hydrateProjects([])).toBe(false);
      expect(activeProject()).toBeNull();
    });

    it("drops entries with no path", () => {
      hydrateProjects([
        { name: "ghost", path: "   ", self_dev: false },
        { name: "real", path: "/work/real", self_dev: false },
      ]);
      expect(recentProjects()).toHaveLength(1);
      expect(activeProject()?.path).toBe("/work/real");
    });

    it("re-derives a name the file left blank", () => {
      hydrateProjects([{ name: "", path: "/work/derived", self_dev: false }]);
      expect(activeProject()?.name).toBe("derived");
    });

    it("round-trips through open", () => {
      openProject("/work/alpha");
      openProject("/work/beta");
      const saved = collectProjects();

      // Newest first — beta was opened last.
      expect(saved[0].path).toBe("/work/beta");

      resetProjects();
      hydrateProjects(saved);

      expect(collectProjects()).toEqual(saved);
      expect(activeProject()?.path).toBe("/work/beta");
    });
  });
});
