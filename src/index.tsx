/* @refresh reload */
import { render } from "solid-js/web";

import "@fontsource/jetbrains-mono/300.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

import "./design/tokens.css";
import "./design/shell.css";
import "./design/common.css";
import "./design/settings.css";
import "./home/home.css";

import { App } from "./shell/App";
import { registerBuiltins } from "./modules";
import { loadConfig } from "./shell/config";
import { hydrateEdges } from "./shell/edges";
import { hydratePrefs } from "./shell/prefs";
import { bootProject, hydrateProjects } from "./shell/project";
import { modules } from "./shell/registry";

/**
 * Boot order, and why it is this order.
 *
 * 1. **Registry first** — the shell needs modules to place on edges before it
 *    renders a frame, and `hydrateEdges` validates stored ids against the
 *    registry, so the registry has to exist before the config is applied.
 * 2. **Config next** — applied before the first render so the configured edges
 *    and toggles are in place for the first frame. Rendering defaults and
 *    correcting them a tick later is a visible flicker on every launch; reading
 *    one small file is faster than that. `loadConfig` has its own timeout, so a
 *    wedged IPC delays the window rather than preventing it forever.
 * 3. **Project last** — and only if the config did not restore one, because
 *    `fs_cwd` answers "where the binary started", which is the wrong answer
 *    once a project can be remembered.
 */
async function boot(): Promise<void> {
  registerBuiltins();

  const { config } = await loadConfig();
  hydrateEdges(
    config.edges,
    modules().map((m) => m.id),
  );
  hydratePrefs(config.performance);
  hydrateProjects(config.projects);

  await bootProject();
}

void boot()
  .catch((err) => console.error("[boot] failed, starting on defaults:", err))
  .finally(() => render(() => <App />, document.getElementById("root")!));
