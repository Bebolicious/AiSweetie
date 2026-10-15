import { register } from "../shell/registry";
import { terminalModule } from "./terminal";
import { gitModule } from "./git";
import { explorerModule } from "./explorer";
import { agentsModule } from "./agents";

/**
 * Built-in modules, registered at boot.
 *
 * Note for the dev loop: this runs once, so editing a module's source while
 * the app is running leaves the registry holding the old instance. Restart
 * `tauri dev` after a module edit until registry.reload() exists.
 */
export function registerBuiltins(): void {
  register(gitModule());
  register(terminalModule());
  register(explorerModule());
  register(agentsModule());
}
