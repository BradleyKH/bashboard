import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Favorite } from './favorites';
import type { NamedLayout } from './layouts';
import type { ReposFile } from './repos';
import type { SavedWorkspace } from './savedWorkspace';

/** One entry of the core's shell activity sweep (docs/design.md section 3.1). */
export interface PtyActivity {
  id: number;
  busy: boolean;
}

/** The core treats both files as opaque JSON, so loads return unvalidated data. */
export function workspaceLoad(): Promise<unknown> {
  return invoke<unknown>('workspace_load');
}

export function workspaceSave(data: SavedWorkspace): Promise<void> {
  return invoke<void>('workspace_save', { data });
}

export function favoritesLoad(): Promise<unknown> {
  return invoke<unknown>('favorites_load');
}

export function favoritesSave(list: Favorite[]): Promise<void> {
  return invoke<void>('favorites_save', { data: list });
}

export function onFavoritesChanged(cb: (raw: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>('favorites://changed', (e) => cb(e.payload));
}

export function layoutsLoad(): Promise<unknown> {
  return invoke<unknown>('layouts_load');
}

export function layoutsSave(list: NamedLayout[]): Promise<void> {
  return invoke<void>('layouts_save', { data: list });
}

export function onLayoutsChanged(cb: (raw: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>('layouts://changed', (e) => cb(e.payload));
}

export function reposLoad(): Promise<unknown> {
  return invoke<unknown>('repos_load');
}

export function reposSave(file: ReposFile): Promise<void> {
  return invoke<void>('repos_save', { data: file });
}

export function onReposChanged(cb: (raw: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>('repos://changed', (e) => cb(e.payload));
}

export function scratchSave(id: string, text: string): Promise<void> {
  return invoke<void>('scratch_save', { id, text });
}

/** An empty string when the pad's file is missing. */
export function scratchLoad(id: string): Promise<string> {
  return invoke<string>('scratch_load', { id });
}

export function scratchDelete(id: string): Promise<void> {
  return invoke<void>('scratch_delete', { id });
}

/** Opens the native save dialog; resolves to the chosen path, or null when cancelled. */
export function scratchSaveAs(text: string): Promise<string | null> {
  return invoke<string | null>('scratch_save_as', { text });
}

export function onPtyActivity(cb: (list: PtyActivity[]) => void): Promise<UnlistenFn> {
  return listen<PtyActivity[]>('pty://activity', (e) => cb(e.payload));
}
