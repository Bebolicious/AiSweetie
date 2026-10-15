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
import { bootProject } from "./shell/project";

// Boot order: registry first, so the shell has modules to place on edges
// before it ever renders a frame; then the active project, so the first
// terminal pane spawns inside it rather than wherever the binary started.
registerBuiltins();

void bootProject()
  .catch((err) => console.error("[boot] could not resolve a project:", err))
  .finally(() => render(() => <App />, document.getElementById("root")!));
