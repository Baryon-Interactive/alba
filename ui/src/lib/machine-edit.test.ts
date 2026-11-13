import { expect, it } from 'vitest';
import { machineForm, machineSet, sshSet } from './machine-edit';
import type { Machine } from '../../../src/machines/config';

const box: Machine = {
  id: 'gpu-amd', name: '5700 XT box', os: 'windows', connect: { ssh: 'gpu-amd' }, engine: 'unreal',
  hardware: { cpu: 'Example 8-core', ram_gb: 32 }, roles: ['gpu-qa'], slots: 1, min_free_mem_gb: 0, timing_allowed: false,
  services: [{ id: 'agent', check: { command: ['agent', '--status'] }, start_hint: 'Start it.' }], workspace: '/data/alba',
};

it('an untouched form changes nothing; a touched field is sent alone; a cleared one is null', () => {
  expect(machineSet(box, machineForm(box))).toEqual({});
  const f = machineForm(box);
  expect(machineSet(box, { ...f, name: 'AMD box', ram: '64' })).toEqual({ name: 'AMD box', hardware: { cpu: 'Example 8-core', ram_gb: 64 } });
  expect(machineSet(box, { ...f, workspace: '', notes: 'moved' })).toEqual({ workspace: null, notes: 'moved' });
  expect(machineSet(box, { ...f, local: true })).toEqual({ connect: { local: true } });
  expect(machineSet(box, { ...f, roles: 'gpu-qa, package' })).toEqual({ roles: ['gpu-qa', 'package'] });
  expect(machineSet(box, { ...f, repos: 'game: /data/alba/repos/game.git' })).toEqual({ repos: { game: '/data/alba/repos/game.git' } });
  expect(machineSet(box, { ...f, services: [] })).toEqual({ services: [] });
  expect(machineSet(box, { ...f, slots: '2', timing: true })).toEqual({ slots: 2, timing_allowed: true });
});

it('only the changed parts of the SSH address are sent', () => {
  const current = { hostname: '192.0.2.57', user: 'dev' };
  expect(sshSet(current, { hostname: '192.0.2.57', user: 'dev', port: '' })).toBeUndefined();
  expect(sshSet(current, { hostname: '192.0.2.77', user: 'dev', port: '22' })).toEqual({ hostname: '192.0.2.77' });
  expect(sshSet(current, { hostname: '192.0.2.57', user: 'studio', port: '2222' })).toEqual({ user: 'studio', port: 2222 });
  expect(sshSet({ ...current, port: 2222 }, { hostname: '192.0.2.57', user: 'dev', port: '' })).toEqual({ port: null });
});
