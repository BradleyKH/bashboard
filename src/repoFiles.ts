import { Channel, invoke } from '@tauri-apps/api/core';

/** docs/design.md section 3.8: the repo a folder belongs to. */
export interface RepoInfo {
  root: string;
  isGit: boolean;
  branch?: string;
}

/** One `fs_list` row; `modified` is integer epoch milliseconds. */
export interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FileText {
  text: string;
  modified: number;
}

export type FileErrorKind = 'binary' | 'tooLarge' | 'conflict' | 'other';

export function repoRoot(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>('repo_root', { path });
}

export function fsList(dir: string): Promise<Entry[]> {
  return invoke<Entry[]>('fs_list', { dir });
}

export function fsReadText(path: string): Promise<FileText> {
  return invoke<FileText>('fs_read_text', { path });
}

/** Resolves to the file's new modified time; rejects with a `conflict:` error when it changed on disk. */
export async function fsWriteText(path: string, text: string, expectedModified: number): Promise<number> {
  const r = await invoke<{ modified: number }>('fs_write_text', { path, text, expectedModified });
  return r.modified;
}

/** Resolves to the moved file's new path. */
export function fsMove(path: string, toDir: string): Promise<string> {
  return invoke<string>('fs_move', { path, toDir });
}

/** Watches one folder (not recursive); resolves to the id to pass to `fsUnwatch`. */
export function fsWatch(dir: string, onChange: () => void): Promise<number> {
  const channel = new Channel<null>();
  channel.onmessage = () => onChange();
  return invoke<number>('fs_watch', { dir, onChange: channel });
}

export function fsUnwatch(id: number): Promise<void> {
  return invoke<void>('fs_unwatch', { id });
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Matches the error prefixes the core emits for the read and write commands. */
export function classifyReadError(err: unknown): FileErrorKind {
  const text = errorText(err);
  if (text.startsWith('binary:')) return 'binary';
  if (text.startsWith('tooLarge:')) return 'tooLarge';
  if (text.startsWith('conflict:')) return 'conflict';
  return 'other';
}
