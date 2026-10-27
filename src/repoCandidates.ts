import { invoke } from '@tauri-apps/api/core';

export interface RepoCandidates {
  /** The folder that was listed, or null when no default folder exists. */
  dir: string | null;
  /** Direct subfolders holding `.git`, sorted by name. */
  repos: { name: string; path: string }[];
}

/** Lists the git repos under `dir`, or under `%USERPROFILE%\source\repos` when omitted. */
export function repoCandidates(dir?: string): Promise<RepoCandidates> {
  return invoke<RepoCandidates>('setup_repo_candidates', { dir: dir ?? null });
}
