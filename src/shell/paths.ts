/**
 * Path display helpers.
 *
 * These exist because the obvious CSS trick for truncating a path from the
 * left — `direction: rtl` — reorders trailing punctuation. A path like
 * "notes/" renders as "/notes", which is wrong in a way that looks like a
 * data bug rather than a styling one. Splitting the string is the honest fix.
 */

export interface SplitPath {
  /** Directory portion, including its trailing separator. May be empty. */
  dir: string;
  /** Final segment, keeping a trailing separator when it is a directory. */
  base: string;
}

export function splitPath(path: string): SplitPath {
  const isDir = /[\\/]$/.test(path);
  const norm = isDir ? path.slice(0, -1) : path;
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));

  const dir = cut === -1 ? "" : norm.slice(0, cut + 1);
  const base = (cut === -1 ? norm : norm.slice(cut + 1)) + (isDir ? "/" : "");

  return { dir, base };
}

/**
 * The last `n` segments, elided at the front. For headers where the full path
 * is too long to be useful but the tail identifies the place.
 */
export function tailSegments(path: string, n = 2): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= n) return path;
  return `…/${parts.slice(-n).join("/")}`;
}
