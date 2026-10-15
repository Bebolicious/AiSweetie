/**
 * Thin wrapper over the Tauri window API so the frontend still runs in a
 * plain browser (`npm run dev`) for fast iteration on layout.
 */

const inTauri = () => "__TAURI_INTERNALS__" in window;

export async function setFullscreen(on: boolean): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setFullscreen(on);
}

export async function quit(): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** Where the host was launched from, or null outside Tauri. */
export async function cwd(): Promise<string | null> {
  if (!inTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("fs_cwd");
}

export async function home(): Promise<string | null> {
  if (!inTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("fs_home");
}

/**
 * Names of the subdirectories of `path`. Rejects when `path` is not a
 * readable directory — which is how the project picker tells a real path
 * from a partial one.
 */
export async function listDirs(path: string): Promise<string[]> {
  if (!inTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const entries = await invoke<{ name: string; dir: boolean }[]>("fs_list", {
    path,
  });
  return entries.filter((e) => e.dir).map((e) => e.name);
}
