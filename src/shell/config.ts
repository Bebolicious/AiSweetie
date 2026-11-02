import { createSignal } from "solid-js";
import { EDGES, type Edge } from "@suite/module";

/**
 * The frontend half of `config.toml`.
 *
 * Mirrors `src-tauri/src/config.rs`. The types are duplicated rather than
 * generated because the generator would be the only build step in the repo and
 * the schema is twenty fields; `configRoundTrip` in the tests is what keeps the
 * two honest.
 *
 * Loading degrades to defaults with no host, like everything in `host.ts`, so
 * `npm run dev` works in a plain browser and simply does not persist.
 */

export interface ConfigFile {
  edges: Record<Edge, string>;
  performance: {
    hardware_accel: boolean;
    panel_blur: boolean;
    bounce: boolean;
  };
  hotkeys: Record<string, string>;
  projects: { name: string; path: string; self_dev: boolean }[];
  ai: { provider: string };
  fleet: {
    coordinator_agent: string;
    environment: string;
    workers: string[];
  };
  modules: { paths: string[] };
}

/** What the host reports about the file it just read. */
export interface Loaded {
  config: ConfigFile;
  path: string;
  /** First run — the file does not exist yet. Not a problem. */
  missing: boolean;
  /** Why the file could not be used. `config` is defaults when set. */
  error: string | null;
  /** Saving is refused — the file exists but could not be parsed. */
  read_only: boolean;
}

export function defaultConfig(): ConfigFile {
  return {
    edges: { top: "git", right: "terminal", bottom: "explorer", left: "agents" },
    performance: { hardware_accel: true, panel_blur: true, bounce: true },
    hotkeys: {},
    projects: [],
    ai: { provider: "anthropic" },
    fleet: { coordinator_agent: "", environment: "", workers: [] },
    modules: { paths: [] },
  };
}

const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * What the last load said, for Settings to show.
 *
 * `read_only` is the one the UI must act on: it means the file on disk is
 * hand-edited and currently broken, so the app is running on defaults and will
 * refuse to save over it. Settings shows the error rather than silently
 * dropping the user's changes.
 */
const [status, setStatus] = createSignal<Loaded | null>(null);
export { status as configStatus };

/**
 * How long to wait for the host before painting anyway.
 *
 * Boot awaits the config so the configured edges are in place for the first
 * frame — reading one small file is faster than the flicker of rendering
 * defaults and correcting them. But the window must paint even if the IPC
 * never answers: an app that waits forever on a wedged call is worse than one
 * that starts with defaults.
 */
const BOOT_TIMEOUT_MS = 2000;

export async function loadConfig(): Promise<Loaded> {
  const fallback: Loaded = {
    config: defaultConfig(),
    path: "",
    missing: false,
    error: null,
    read_only: !inTauri(), // no host, nowhere to save
  };

  if (!inTauri()) {
    setStatus(fallback);
    return fallback;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const loaded = await Promise.race([
      invoke<Loaded>("config_load"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), BOOT_TIMEOUT_MS),
      ),
    ]);
    setStatus(loaded);
    if (loaded.error) console.error("[config]", loaded.error);
    return loaded;
  } catch (err) {
    const failed = {
      ...fallback,
      error: `could not load the config: ${String(err)}`,
      read_only: true,
    };
    console.error("[config]", failed.error);
    setStatus(failed);
    return failed;
  }
}

/**
 * Write the config back.
 *
 * Returns the error rather than throwing, because the caller is Settings
 * closing — a failed save must be visible but must not prevent the modal from
 * closing or take the shell down with it.
 */
export async function saveConfig(config: ConfigFile): Promise<string | null> {
  if (!inTauri()) return null;

  const current = status();
  if (current?.read_only) {
    // The host would refuse anyway; skipping the call keeps the reason the one
    // the user was already shown rather than a second, vaguer message.
    return current.error ?? "the config on disk is not readable";
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string>("config_save", { config });
    setStatus({ config, path, missing: false, error: null, read_only: false });
    return null;
  } catch (err) {
    const message = `could not save the config: ${String(err)}`;
    console.error("[config]", message);
    return message;
  }
}

/** Every edge key, for validating a hand-edited `[edges]` block. */
export function isEdge(key: string): key is Edge {
  return (EDGES as readonly string[]).includes(key);
}
