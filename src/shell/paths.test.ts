import { describe, expect, it } from "vitest";
import { splitPath, tailSegments } from "./paths";

describe("splitPath", () => {
  it("splits a nested file path", () => {
    expect(splitPath("src/shell/track.ts")).toEqual({
      dir: "src/shell/",
      base: "track.ts",
    });
  });

  it("leaves a bare filename with no directory", () => {
    expect(splitPath("package.json")).toEqual({ dir: "", base: "package.json" });
  });

  it("keeps the trailing slash on a directory, where rtl would move it", () => {
    // git status reports untracked directories as "notes/".
    expect(splitPath("notes/")).toEqual({ dir: "", base: "notes/" });
    expect(splitPath("src/notes/")).toEqual({ dir: "src/", base: "notes/" });
  });

  it("handles Windows separators", () => {
    expect(splitPath("src\\shell\\track.ts")).toEqual({
      dir: "src\\shell\\",
      base: "track.ts",
    });
  });
});

describe("tailSegments", () => {
  it("elides all but the last segments", () => {
    expect(tailSegments("/a/b/c/d/e", 2)).toBe("…/d/e");
  });

  it("returns the path untouched when it is already short", () => {
    expect(tailSegments("a/b", 2)).toBe("a/b");
    expect(tailSegments("solo", 2)).toBe("solo");
  });

  it("works on Windows paths", () => {
    expect(tailSegments("C:\\Users\\me\\proj\\src", 2)).toBe("…/proj/src");
  });
});
