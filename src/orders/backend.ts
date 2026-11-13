import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { SqliteStore } from './sqlite-store.ts';
import { FileStore, type OrderStore } from './store.ts';

export type StateProject = Pick<ProjectConfig, 'state_dir' | 'state'>;
export type BackendName = 'sqlite' | 'files';

export function backendName(project: StateProject): BackendName {
  return project.state.backend;
}

// One connection per state folder per process; requests and ticks do not leak a connection each time.
const connections = new Map<string, SqliteStore>();
const fileStores = new Map<string, FileStore>();
export function stateStore(project: StateProject): OrderStore {
  const key = path.resolve(project.state_dir);
  if (backendName(project) === 'files') {
    let store = fileStores.get(key);
    if (!store) { store = new FileStore(key); fileStores.set(key, store); }
    return store;
  }
  let store = connections.get(key);
  if (!store) { store = new SqliteStore(key); connections.set(key, store); }
  return store;
}
export function closeStateStores(): void {
  for (const store of connections.values()) store.close();
  connections.clear();
  fileStores.clear();
}
