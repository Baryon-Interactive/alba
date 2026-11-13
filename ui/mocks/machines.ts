// The machine registry calls, answered from made-up machines (nothing is probed, installed or written).
import type { ServerResponse } from 'node:http';
import { makeMachines } from '../src/mocks/machine-data.ts';

export interface MachineCtx {
  path: string;
  method: string;
  url: URL;
  body: any;
  project: string;
  res: ServerResponse;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  fail: (res: ServerResponse, status: number, code: string, message: string) => void;
}

export function handleMachines(c: MachineCtx): boolean {
  const { path, method, res, send, fail, project } = c;
  const machines = makeMachines();
  if (path === 'machines' || (path === 'machines/check' && method === 'POST')) return send(res, 200, { project, machines }), true;
  if (path === 'machines/guide') return send(res, 200, { project, registry: 'machines.yaml', sshConfig: '~/.ssh/config', publicKeys: [{ file: '~/.ssh/id_ed25519.pub', key: 'ssh-ed25519 AAAAC3Nza… studio@studio-pc' }], platform: 'win32' }), true;
  if (path === 'machines/jobs') return send(res, 200, { jobs: machines.flatMap(m => m.jobs) }), true;
  if (path === 'machines/install-plan') return send(res, 200, { plan: { item: c.url.searchParams.get('item'), title: 'Install', steps: ['winget install …'], notes: [] } }), true;
  if (path.startsWith('machines/')) return fail(res, 409, 'conflict', 'The mock console does not change machines.'), true;
  return false;
}
