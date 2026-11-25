import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject, type ProjectConfig } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { tmpDir } from './tmp.ts';

/** A project folder with the given files (relative path -> text) and a project file that turns on the library sections it names. */
export function libraryProject(files: Record<string, string>, sections: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): { project: ProjectConfig; orders: Orders; dir: string; root: string; write: (rel: string, text: string) => void } {
  const dir = tmpDir('alba-lib-');
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const write = (rel: string, text: string) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text, 'utf8'); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const project = validateProject({ id: 'demo', name: 'Demo', root: 'game', work_orders: 'orders', state_dir: 'state', ...sections, ...extra }, path.join(dir, 'alba.yaml'));
  let tick = 0;
  const orders = new Orders(testStore(project.state_dir), () => new Date(Date.UTC(2026, 10, 1, 0, tick++)).toISOString(), 'test');
  return { project, orders, dir, root, write };
}

/** A tiny png header: enough for a file that exists. */
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63000100000005000106e1f0a50000000049454e44ae426082', 'hex');
