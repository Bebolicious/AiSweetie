import { createSignal } from "solid-js";
import type { Project } from "@suite/module";
import { cwd } from "./host";

/**
 * The active project and the list of recent ones.
 *
 * Shell-level on purpose — see the `project` note on `ModuleContext`. One
 * signal, read by every module through its context, so switching re-scopes
 * git, explorer, terminal and agents together.
 *
 * In-memory only, like `edges.ts` and `prefs.ts`: persistence is ROADMAP 0.1,
 * and these hydrate from `[[projects]]` in config.toml when that lands. A
 * second mechanism here would be a migration later.
 */

const MAX_RECENT = 8;

const [activeProject, setActiveProject] = createSignal<Project | null>(null);
const [recentProjects, setRecentProjects] = createSignal<Project[]>([]);
export { activeProject, recentProjects };

/** Strip trailing separators, except on a root ("/" or "C:\"). */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  if (stripped === "") return trimmed ? trimmed[0] : "";
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

export function projectFromPath(path: string): Project {
  const norm = normalizePath(path);
  const name = norm.split(/[\\/]/).filter(Boolean).pop() ?? norm;
  return { id: norm, name, path: norm };
}

/** Make a directory the active project and move it to the top of recents. */
export function openProject(path: string): Project {
  const project = projectFromPath(path);
  setActiveProject(project);
  setRecentProjects((list) =>
    [project, ...list.filter((p) => p.id !== project.id)].slice(0, MAX_RECENT),
  );
  return project;
}

/** Seed from wherever the host was launched. No-op in the browser build. */
export async function bootProject(): Promise<void> {
  const dir = await cwd();
  if (dir) openProject(dir);
}

/** Test seam. */
export function resetProjects(): void {
  setActiveProject(null);
  setRecentProjects([]);
}
