/**
 * The entire public surface a module sees.
 *
 * A module renders into a container it does not own, at a size it does not
 * choose, in a hue it is handed. That constraint is the whole point: any
 * module must work on any edge and look native there.
 */

export type Edge = "top" | "right" | "bottom" | "left";
export const EDGES: readonly Edge[] = ["top", "right", "bottom", "left"];

export interface SuiteModule {
  /** Stable identity. This is the key written to config.toml. */
  readonly id: string;
  /** Rendered by the shell in the module header — not by the module. */
  readonly title: string;
  readonly version: string;

  mount(container: HTMLElement, ctx: ModuleContext): void | Promise<void>;
  unmount(): void | Promise<void>;

  /** Declarative, so Settings can enumerate and rebind every binding. */
  keymap(): Binding[];

  /** Read by the home screen and the module header. Cheap and synchronous. */
  status(): StatusSummary;
}

export interface ModuleContext {
  /**
   * Which edge this module currently occupies and that edge's hue — supplied,
   * never chosen. Re-supplied on reassignment without a remount.
   */
  readonly edge: () => Edge;
  readonly accent: () => string;

  /**
   * The project the suite is looking at. Shell-level, not per module: if git
   * switched repository but the explorer tree, the terminal's working
   * directory and the agents' cwd did not follow, the app would be lying
   * about where you are. A getter, like `edge`: switching re-supplies it
   * without a remount, so live PTYs survive. Null until the host has
   * answered, and always null in the browser dev build.
   */
  readonly project: () => Project | null;

  readonly bus: Bus;
  readonly focus: FocusScope;
  readonly nav: Nav;
}

export interface Project {
  /** Stable identity. The normalized path today; config.toml's key later. */
  id: string;
  /** Last path segment — what to show when the full path would be noise. */
  name: string;
  path: string;
  /** This is the suite's own repository (ROADMAP 0.5). */
  selfDev?: boolean;
}

export interface StatusSummary {
  /** Middle of the module header: "hypr-suite / feat/edges · 4 changed". */
  header: string;
  /** One line for the home screen edge map: "feat/edges · 4 dirty". */
  home: string;
  tone?: "idle" | "active" | "attention";
}

export interface Binding {
  /** Namespaced: "git.stageHunk". The rebind key in config.toml. */
  id: string;
  /** Normalized chord: "space", "mod+k", "shift+g". mod = Cmd on macOS. */
  keys: string;
  /** Shown in the Settings hotkey list. */
  label: string;
  run(): void;
}

export interface FocusScope {
  /**
   * Register a text surface. While one is focused the shell stops routing
   * bare keys as commands — this is what keeps `,` from opening Settings
   * mid-sentence. Chords with a modifier still route. Returns a disposer.
   */
  claimText(el: HTMLElement): () => void;
  hasTextFocus(): boolean;
}

export interface Nav {
  /** Slide back to the home screen. */
  home(): void;
  /** Slide to whichever module occupies that edge. */
  toEdge(edge: Edge): void;
}

/**
 * Cross-module messages. Closed union on purpose: fully typed and
 * discoverable while the module set is ours. An open channel gets added
 * alongside this when third-party modules become real.
 */
export interface BusEvents {
  "file.open": { path: string; line?: number };
  "git.stage": { path: string; hunk?: number };
  "agent.spawn": { prompt: string; cwd: string };
}

export interface Bus {
  emit<K extends keyof BusEvents>(k: K, payload: BusEvents[K]): void;
  on<K extends keyof BusEvents>(k: K, fn: (p: BusEvents[K]) => void): () => void;
}
