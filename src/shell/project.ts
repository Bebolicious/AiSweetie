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

/**
 * Adopt persisted projects (ROADMAP 0.1 + 0.4).
 *
 * The list is recency-ordered, so the first entry becomes active. Returns
 * whether anything was restored, which is how `bootProject` knows not to
 * override a remembered project with the directory the binary happened to
 * start in.
 */
export function hydrateProjects(
  stored: { name: string; path: string; self_dev?: boolean }[],
): boolean {
  const projects = stored
    .filter((p) => p.path.trim() !== "")
    .map((p) => ({
      ...projectFromPath(p.path),
      // The stored name is kept only if it was customised; otherwise derive it,
      // so a renamed directory does not keep showing its old name forever.
      name: p.name.trim() || projectFromPath(p.path).name,
      selfDev: p.self_dev ?? false,
    }))
    .slice(0, MAX_RECENT);

  if (projects.length === 0) return false;

  setRecentProjects(projects);
  setActiveProject(projects[0]);
  return true;
}

/** The recents list, shaped for `config.toml`. */
export function collectProjects() {
  return recentProjects().map((p) => ({
    name: p.name,
    path: p.path,
    self_dev: p.selfDev ?? false,
  }));
}

/**
 * Seed from wherever the host was launched. No-op in the browser build.
 *
 * Skipped entirely when the config already restored a project: `fs_cwd` answers
 * "where the binary started", which after 0.1 is the wrong answer — reopening
 * the app should land you where you left off, not wherever the launcher lives.
 */
export async function bootProject(): Promise<void> {
  if (activeProject()) return;
  const dir = await cwd();
  if (dir) openProject(dir);
}

/** Test seam. */
export function resetProjects(): void {
  setActiveProject(null);
  setRecentProjects([]);
}
