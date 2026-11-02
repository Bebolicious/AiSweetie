import { invoke } from "@tauri-apps/api/core";

export interface FileChange {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface Branch {
  name: string;
  current: boolean;
  age: string;
}

export interface Commit {
  hash: string;
  subject: string;
  age: string;
  refs: string;
}

export interface RepoStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
}

export const hasHost = () => "__TAURI_INTERNALS__" in window;

export const git = {
  root: (start: string) => invoke<string>("git_root", { start }),
  status: (repo: string) => invoke<RepoStatus>("git_status", { repo }),
  /**
   * Branches and the log are cached on the host against a fingerprint of the
   * repository's refs, so a reload that cannot have moved a ref — staging,
   * for instance — costs nothing. `fresh` skips the lookup, which is what the
   * explicit refresh binding passes so that refresh means refresh.
   */
  branches: (repo: string, fresh = false) =>
    invoke<Branch[]>("git_branches", { repo, fresh }),
  log: (repo: string, limit = 12, fresh = false) =>
    invoke<Commit[]>("git_log", { repo, limit, fresh }),
  diff: (repo: string, path: string, staged: boolean) =>
    invoke<string>("git_diff", { repo, path, staged }),
  applyPatch: (repo: string, patch: string, reverse: boolean) =>
    invoke<void>("git_apply_patch", { repo, patch, reverse }),
  stageFile: (repo: string, path: string, unstage: boolean) =>
    invoke<void>("git_stage_file", { repo, path, unstage }),
  commit: (repo: string, message: string) =>
    invoke<string>("git_commit", { repo, message }),
};
