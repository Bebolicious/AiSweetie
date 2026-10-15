/**
 * Unified-diff parsing.
 *
 * Pure string work, deliberately kept out of Rust so it can be tested without
 * a repository. Everything hunk staging depends on lives here, so it is worth
 * being exact about.
 */

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number in the pre-image, absent for additions. */
  oldNo?: number;
  /** Line number in the post-image, absent for deletions. */
  newNo?: number;
}

export interface Hunk {
  /** The literal `@@ … @@` line, including any trailing section heading. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface FileDiff {
  path: string;
  /** Everything before the first hunk — needed verbatim to build a patch. */
  preamble: string[];
  hunks: Hunk[];
  added: number;
  removed: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseDiff(raw: string): FileDiff | null {
  // `git diff` prints nothing for an unchanged file, and "".split("\n") is
  // [""] rather than [] — so this has to be checked before parsing, not after.
  if (raw.trim() === "") return null;

  const lines = raw.split("\n");
  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  let path = "";
  let current: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const match = HUNK_RE.exec(line);

    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
        added: 0,
        removed: 0,
      };
      oldNo = current.oldStart;
      newNo = current.newStart;
      hunks.push(current);
      continue;
    }

    if (!current) {
      preamble.push(line);
      const plus = /^\+\+\+ b\/(.*)$/.exec(line);
      if (plus) path = plus[1];
      continue;
    }

    // "\ No newline at end of file" carries no line numbering.
    if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }

    const body = line.slice(1);
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: body, newNo: newNo++ });
      current.added++;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: body, oldNo: oldNo++ });
      current.removed++;
    } else if (line.startsWith(" ") || line === "") {
      // A truly empty trailing line is the split artefact, not content.
      if (line === "" ) continue;
      current.lines.push({
        kind: "context",
        text: body,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }

  return {
    path,
    preamble,
    hunks,
    added: hunks.reduce((n, h) => n + h.added, 0),
    removed: hunks.reduce((n, h) => n + h.removed, 0),
  };
}

/**
 * Rebuild a minimal, valid patch containing exactly one hunk.
 *
 * The preamble must be carried verbatim — `git apply` needs the `---`/`+++`
 * pair to know which file it is touching. The hunk header is reused unchanged;
 * its offsets may not line up with the index when earlier hunks are unstaged,
 * and that is fine, because `git apply` locates the change by its context.
 */
export function hunkPatch(file: FileDiff, hunk: Hunk): string {
  const body = hunk.lines.map((l) => {
    if (l.kind === "meta") return l.text;
    const sigil = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    return sigil + l.text;
  });

  return [...file.preamble, hunk.header, ...body, ""].join("\n");
}
