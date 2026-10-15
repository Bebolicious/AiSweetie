import { createBus } from "./bus";
import { createRouter } from "./keymap";

/** One bus and one key router for the whole shell. */
export const bus = createBus();
export const router = createRouter();
