import { beforeEach, describe, expect, it } from "vitest";
import {
  activeProject,
  normalizePath,
  openProject,
  projectFromPath,
  recentProjects,
  resetProjects,
} from "./project";

describe("normalizePath", () => {
  it("strips trailing separators but keeps a root", () => {
    expect(normalizePath("/home/alex/Projects/")).toBe("/home/alex/Projects");
    expect(normalizePath("C:\\code\\suite\\")).toBe("C:\\code\\suite");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("C:\\")).toBe("C:\\");
    expect(normalizePath("  /tmp  ")).toBe("/tmp");
  });
});

describe("projectFromPath", () => {
  it("names the project after its last segment on either separator", () => {
    expect(projectFromPath("/home/alex/Projects/suite/").name).toBe("suite");
    expect(projectFromPath("C:\\code\\suite").name).toBe("suite");
  });
});

describe("openProject", () => {
  beforeEach(resetProjects);

  it("starts with no project", () => {
    expect(activeProject()).toBeNull();
    expect(recentProjects()).toEqual([]);
  });

  it("makes the path active and puts it first in recents", () => {
    openProject("/a");
    openProject("/b");
    expect(activeProject()?.path).toBe("/b");
    expect(recentProjects().map((p) => p.path)).toEqual(["/b", "/a"]);
  });

  it("dedupes by normalized path when reopening", () => {
    openProject("/a");
    openProject("/b");
    openProject("/a/");
    expect(recentProjects().map((p) => p.path)).toEqual(["/a", "/b"]);
  });

  it("keeps the recent list bounded", () => {
    for (let i = 0; i < 12; i++) openProject(`/p${i}`);
    expect(recentProjects()).toHaveLength(8);
    expect(recentProjects()[0].path).toBe("/p11");
  });
});
