import { invoke } from '@tauri-apps/api/core';

/** One model a server has loaded (docs/design.md section 3.19). */
export interface LoadedModel {
  name: string;
  /** Total bytes; 0 when the server does not say. */
  size: number;
  /** Bytes in GPU memory; null when the server does not say (LM Studio). */
  sizeVram: number | null;
  contextLength: number | null;
  /** RFC 3339 time Ollama unloads the model. */
  expiresAt: string | null;
}

export interface ServerInfo {
  url: string;
  version: string | null;
  models: LoadedModel[];
}

/** A server that does not answer is null. */
export interface ModelServersSnapshot {
  ollama: ServerInfo | null;
  lmStudio: ServerInfo | null;
  ollamaOnPath: boolean;
}

export interface InstalledModel {
  name: string;
  size: number;
}

export function pollModelServers(): Promise<ModelServersSnapshot> {
  return invoke<ModelServersSnapshot>('model_servers_poll');
}

/** Installed Ollama models; empty when the server does not answer. */
export function listOllamaModels(): Promise<InstalledModel[]> {
  return invoke<InstalledModel[]>('model_servers_ollama_models');
}
