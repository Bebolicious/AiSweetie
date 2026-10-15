import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  hidden: boolean;
}

export interface FileBody {
  text: string;
  lines: number;
  bytes: number;
  textual: boolean;
}

export const hasHost = () => "__TAURI_INTERNALS__" in window;

export const fsx = {
  list: (path: string) => invoke<Entry[]>("fs_list", { path }),
  read: (path: string) => invoke<FileBody>("fs_read", { path }),
};

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function humanSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const n = bytes / 1024 ** i;
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Case-insensitive subsequence match, the standard fuzzy-jump rule. */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return i === n.length;
}

export const parentOf = (path: string): string | null => {
  const norm = path.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (cut <= 0) return null;
  const parent = norm.slice(0, cut);
  // Keep the trailing separator on a Windows drive root ("C:" → "C:\").
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
};
