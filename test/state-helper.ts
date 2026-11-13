import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadProject as load, validateProject as validate, type ProjectConfig } from '../src/config.ts';
import { FileStore, type OrderStore } from '../src/orders/store.ts';
import { stateStore } from '../src/orders/backend.ts';

export const testBackend = (): 'files' | 'sqlite' => process.env.ALBA_TEST_STORE === 'sqlite' ? 'sqlite' : 'files';
export function testStore(dir: string): OrderStore { return stateStore({ state_dir: dir, state: { backend: testBackend() } }); }
export function validateProject(raw: unknown, file: string): ProjectConfig {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('state' in raw)) raw = { ...raw, state: { backend: testBackend() } };
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('roles' in raw)) raw = { ...raw, roles: { default: {} } };
  return validate(raw, file);
}
/** Fixture project files also tell the real CLI/server which backend this test run exercises. */
export function selectTestBackend(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  const raw = parse(text);
  if (raw && typeof raw === 'object') {
    const additions = [!('state' in raw) ? `state: { backend: ${testBackend()} }` : '', !('roles' in raw) ? 'roles: { default: {} }' : ''].filter(Boolean);
    if (additions.length) writeFileSync(file, text + '\n' + additions.join('\n') + '\n');
  }
}
export function loadProject(file: string): ProjectConfig { selectTestBackend(file); return load(file); }
export type { ProjectConfig };
