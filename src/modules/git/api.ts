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
  branches: (repo: string) => invoke<Branch[]>("git_branches", { repo }),
  log: (repo: string, limit = 12) => invoke<Commit[]>("git_log", { repo, limit }),
  diff: (repo: string, path: string, staged: boolean) =>
    invoke<string>("git_diff", { repo, path, staged }),
  applyPatch: (repo: string, patch: string, reverse: boolean) =>
    invoke<void>("git_apply_patch", { repo, patch, reverse }),
  stageFile: (repo: string, path: string, unstage: boolean) =>
    invoke<void>("git_stage_file", { repo, path, unstage }),
  commit: (repo: string, message: string) =>
    invoke<string>("git_commit", { repo, message }),
};
