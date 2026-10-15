import { describe, expect, it } from "vitest";
import { hunkPatch, parseDiff } from "./diff";

const SAMPLE = `diff --git a/src/stage.rs b/src/stage.rs
index 1a2b3c4..5d6e7f8 100644
--- a/src/stage.rs
+++ b/src/stage.rs
@@ -84,7 +84,9 @@ impl DiffView
     fn hunks(&self) -> &[Hunk] {
         &self.hunks
     }
-    pub fn stage(&mut self, i: usize) {
-        self.hunks[i].staged = true;
+    pub fn stage(&mut self, i: usize) -> Result<()> {
+        let hunk = self.hunks.get_mut(i).ok_or(Error::NoHunk)?;
+        hunk.staged = true;
+        Ok(())
     }
@@ -212,6 +214,7 @@ impl HunkCursor
     fn next(&mut self) {
-        self.i += 1;
+        self.i = (self.i + 1).min(self.len - 1);
+        self.scroll_into_view();
     }
`;

describe("parseDiff", () => {
  const file = parseDiff(SAMPLE)!;

  it("finds the path from the +++ line", () => {
    expect(file.path).toBe("src/stage.rs");
  });

  it("splits into hunks", () => {
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0].oldStart).toBe(84);
    expect(file.hunks[0].oldCount).toBe(7);
    expect(file.hunks[0].newStart).toBe(84);
    expect(file.hunks[0].newCount).toBe(9);
  });

  it("keeps the section heading on the hunk header", () => {
    expect(file.hunks[0].header).toBe("@@ -84,7 +84,9 @@ impl DiffView");
  });

  it("counts additions and removals per hunk and per file", () => {
    expect(file.hunks[0].added).toBe(4);
    expect(file.hunks[0].removed).toBe(2);
    expect(file.added).toBe(6);
    expect(file.removed).toBe(3);
  });

  it("numbers old and new lines independently", () => {
    const [h] = file.hunks;
    const firstContext = h.lines.find((l) => l.kind === "context")!;
    expect(firstContext.oldNo).toBe(84);
    expect(firstContext.newNo).toBe(84);

    // Additions advance only the new-side counter.
    const adds = h.lines.filter((l) => l.kind === "add");
    expect(adds[0].oldNo).toBeUndefined();
    expect(adds.map((l) => l.newNo)).toEqual([87, 88, 89, 90]);

    const dels = h.lines.filter((l) => l.kind === "del");
    expect(dels.map((l) => l.oldNo)).toEqual([87, 88]);
    expect(dels[0].newNo).toBeUndefined();
  });

  it("handles a single-line hunk with no comma in the range", () => {
    const one = parseDiff(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    )!;
    expect(one.hunks[0].oldCount).toBe(1);
    expect(one.hunks[0].newCount).toBe(1);
  });

  it("returns null for empty input, which is what an unchanged file gives", () => {
    expect(parseDiff("")).toBeNull();
    expect(parseDiff("   \n\n")).toBeNull();
  });
});

describe("hunkPatch", () => {
  const file = parseDiff(SAMPLE)!;

  it("carries the preamble so git knows which file is being patched", () => {
    const patch = hunkPatch(file, file.hunks[1]);
    expect(patch).toContain("--- a/src/stage.rs");
    expect(patch).toContain("+++ b/src/stage.rs");
  });

  it("contains exactly the one hunk asked for", () => {
    const patch = hunkPatch(file, file.hunks[1]);
    expect(patch).toContain("@@ -212,6 +214,7 @@");
    expect(patch).not.toContain("@@ -84,7 +84,9 @@");
  });

  it("round-trips: reparsing a single-hunk patch yields that hunk", () => {
    const patch = hunkPatch(file, file.hunks[0]);
    const again = parseDiff(patch)!;
    expect(again.hunks).toHaveLength(1);
    expect(again.hunks[0].header).toBe(file.hunks[0].header);
    expect(again.hunks[0].added).toBe(file.hunks[0].added);
    expect(again.hunks[0].removed).toBe(file.hunks[0].removed);
    expect(again.path).toBe("src/stage.rs");
  });

  it("restores the original sigils on every line", () => {
    const patch = hunkPatch(file, file.hunks[0]).split("\n");
    expect(patch).toContain("-    pub fn stage(&mut self, i: usize) {");
    expect(patch).toContain("+        Ok(())");
    expect(patch).toContain("     fn hunks(&self) -> &[Hunk] {");
  });

  it("ends with a trailing newline, which git apply requires", () => {
    expect(hunkPatch(file, file.hunks[0]).endsWith("\n")).toBe(true);
  });
});
