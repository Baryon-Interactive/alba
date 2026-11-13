// Made-up machines for the mock console: this computer, two Windows hosts that run workers, a Linux simulation box and a laptop
// that is switched off. Readings move a little on every call so that the page looks alive.
import type { MachineReading, MachineView } from '../../../src/machines/probe.ts';
import type { Capabilities } from '../../../src/machines/capabilities.ts';

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function history(id: string, total: number, base: number, swing: number): MachineReading[] {
  const out: MachineReading[] = [];
  for (let i = 0; i < 48; i++) {
    const free = Math.max(0.5, base + Math.sin(i / 4 + id.length) * swing + Math.cos(i / 9) * swing * 0.4);
    out.push({ id, at: iso((48 - i) * 0.5 * HOUR), reachable: true, free_mem_gb: Number(free.toFixed(1)), total_mem_gb: total, load: 0.3, disks: [], services: [] });
  }
  return out;
}

function caps(c: Partial<Capabilities>): Capabilities {
  return { at: iso(5 * HOUR), gpus: [], tools: {}, ...c };
}

const wobble = (n: number, by: number) => Number((n + (Math.random() - 0.5) * by).toFixed(2));

export function makeMachines(): MachineView[] {
  const reading = (id: string, r: Partial<MachineReading>): MachineReading => ({ id, at: iso(70_000 + Math.random() * 60_000), reachable: true, disks: [], services: [], ...r });
  return [
    {
      id: 'studio-pc', name: 'Studio PC', os: 'windows', connect: { local: true }, hardware: { cpu: 'Ryzen 9 7950X', ram_gb: 64, gpu: 'RTX 4080' },
      roles: ['controller', 'build'], slots: 3, min_free_mem_gb: 8, timing_allowed: false, services: [{ id: 'image-gateway', check: { http: 'http://127.0.0.1:8188/health' } }],
      latest: reading('studio-pc', { free_mem_gb: wobble(23.4, 2), total_mem_gb: 63.2, load: wobble(0.46, 0.12), uptime_seconds: 52 * 3600, disks: [{ mount: 'C:', free_gb: 312, total_gb: 931 }, { mount: 'D:', free_gb: 1210, total_gb: 3726 }], services: [{ id: 'image-gateway', up: true }] }),
      history: history('studio-pc', 63.2, 24, 6),
      capabilities: caps({ cpu: 'AMD Ryzen 9 7950X', cores: 16, threads: 32, ram_gb: 64, os_version: 'Windows 11 Pro 24H2', gpus: [{ name: 'NVIDIA GeForce RTX 4080', vendor: 'nvidia', vram_gb: 16 }], tools: { git: '2.47.1', 'git-lfs': '3.6.0', python: '3.12.7', node: '24.4.0', cmake: '3.30.2', cl: '19.42', claude: '2.3.0', opencode: '0.14.2' } }),
      suggestions: { roles: [{ role: 'gpu-qa', reason: 'Discrete graphics card NVIDIA GeForce RTX 4080 (16 GB).', key: 'Discrete graphics card {gpu} ({vram} GB).', vars: { gpu: 'NVIDIA GeForce RTX 4080', vram: 16 } }], missing: [] },
      jobs: [],
    },
    {
      id: 'gpu-box', name: 'GPU box', os: 'windows', connect: { ssh: 'gpu-box' }, hardware: { cpu: 'Core i7-13700K', ram_gb: 32, gpu: 'RTX 4090' },
      roles: ['gpu-qa', 'editor'], slots: 2, min_free_mem_gb: 6, timing_allowed: true, notes: 'Logs on automatically, so editors can open a window on its desktop.',
      services: [{ id: 'unreal-mcp', check: { tcp: 'gpu-box:8201' }, start_hint: 'Started by the run that holds the ue-editor port.' }],
      latest: reading('gpu-box', { free_mem_gb: wobble(9.8, 1.4), total_mem_gb: 31.8, load: wobble(0.81, 0.1), uptime_seconds: 9 * 24 * 3600, disks: [{ mount: 'C:', free_gb: 188, total_gb: 476 }, { mount: 'D:', free_gb: 702, total_gb: 1863 }], services: [{ id: 'unreal-mcp', up: true }] }),
      history: history('gpu-box', 31.8, 11, 4),
      capabilities: caps({ cpu: '13th Gen Intel Core i7-13700K', cores: 16, threads: 24, ram_gb: 32, os_version: 'Windows 11 Pro 24H2', gpus: [{ name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', vram_gb: 24 }], tools: { git: '2.47.1', 'git-lfs': '3.6.0', node: '24.4.0', python: '3.12.7', codex: '0.61.0' }, engines: { unreal: { versions: ['5.6'], features: { editor: ['UnrealEditor.exe'], build: ['UBA agent'] } } } }),
      suggestions: { roles: [{ role: 'gpu-qa', reason: 'Discrete graphics card NVIDIA GeForce RTX 4090 (24 GB).', key: 'Discrete graphics card {gpu} ({vram} GB).', vars: { gpu: 'NVIDIA GeForce RTX 4090', vram: 24 } }], missing: [{ what: 'cmake', for: 'sim', item: 'cmake' }] },
      jobs: [{ id: 'job-cmake-1', machine: 'gpu-box', kind: 'install', item: 'cmake', title: 'Install CMake', display: ['winget install Kitware.CMake'], status: 'running', started: iso(3 * 60_000), step: 'winget install Kitware.CMake', output: 'Found CMake [Kitware.CMake] Version 3.31.0\nDownloading … 41%', runner_pid: 4412 }],
    },
    {
      id: 'build-box', name: 'Build box', os: 'windows', connect: { ssh: 'build-box' }, hardware: { cpu: 'Threadripper 7960X', ram_gb: 128, gpu: 'RTX A2000' },
      roles: ['build', 'package'], slots: 4, min_free_mem_gb: 16, timing_allowed: false,
      services: [{ id: 'uba-agent', check: { process: 'UbaAgent.exe' } }, { id: 'ddc-share', check: { tcp: 'build-box:445' } }],
      latest: reading('build-box', { free_mem_gb: wobble(71.5, 6), total_mem_gb: 127.6, load: wobble(0.64, 0.15), uptime_seconds: 21 * 24 * 3600, disks: [{ mount: 'C:', free_gb: 402, total_gb: 953 }, { mount: 'E:', free_gb: 2730, total_gb: 7452 }], services: [{ id: 'uba-agent', up: true }, { id: 'ddc-share', up: true }] }),
      history: history('build-box', 127.6, 70, 18),
      capabilities: caps({ cpu: 'AMD Ryzen Threadripper 7960X', cores: 24, threads: 48, ram_gb: 128, os_version: 'Windows Server 2025', gpus: [{ name: 'NVIDIA RTX A2000', vendor: 'nvidia', vram_gb: 6 }], tools: { git: '2.47.1', 'git-lfs': '3.6.0', cmake: '3.30.2', ninja: '1.12.1', cl: '19.42', node: '24.4.0', python: '3.12.7', opencode: '0.14.2' } }),
      suggestions: { roles: [{ role: 'package', reason: 'Unreal Engine 5.6 is installed.', key: 'Unreal Engine {version} is installed.', vars: { version: '5.6' } }], missing: [] },
      jobs: [{ id: 'job-ue-copy', machine: 'build-box', kind: 'install', item: 'unreal-engine', title: 'Copy Unreal Engine 5.6', display: ['8 parallel gzip streams over SSH'], status: 'ok', started: iso(26 * HOUR), ended: iso(25.2 * HOUR), output: 'copied 118.4 GB in 47 min', exit_code: 0, runner_pid: 3020 }],
    },
    {
      id: 'sim-linux', name: 'Simulation box', os: 'linux', connect: { ssh: 'sim-linux' }, hardware: { cpu: 'EPYC 4464P', ram_gb: 64 },
      roles: ['sim'], slots: 2, min_free_mem_gb: 4, timing_allowed: true,
      services: [{ id: 'sim-api', check: { http: 'http://sim-linux:8080/health' } }],
      latest: reading('sim-linux', { free_mem_gb: wobble(40.1, 3), total_mem_gb: 62.7, load: wobble(0.22, 0.08), uptime_seconds: 61 * 24 * 3600, disks: [{ mount: '/', free_gb: 690, total_gb: 1800 }], services: [{ id: 'sim-api', up: true }] }),
      history: history('sim-linux', 62.7, 40, 5),
      capabilities: caps({ cpu: 'AMD EPYC 4464P', cores: 12, threads: 24, ram_gb: 64, os_version: 'Ubuntu 24.04', tools: { git: '2.43.0', python3: '3.12.3', cmake: '3.28.3', gcc: '13.2.0', docker: '27.3.1' } }),
      suggestions: { roles: [], missing: [] },
      jobs: [],
    },
    {
      id: 'art-mac', name: 'Art Mac', os: 'macos', connect: { ssh: 'art-mac' }, hardware: { cpu: 'Apple M3 Max', ram_gb: 48 },
      roles: ['art-review'], slots: 1, min_free_mem_gb: 4, timing_allowed: false, services: [],
      latest: { id: 'art-mac', at: iso(4 * 60_000), reachable: false, error: 'no answer', disks: [], services: [] },
      history: history('art-mac', 48, 20, 3).slice(0, 30),
      capabilities: caps({ cpu: 'Apple M3 Max', cores: 14, threads: 14, ram_gb: 48, os_version: 'macOS 15.4', gpus: [{ name: 'Apple M3 Max', vendor: 'apple' }], tools: { git: '2.39.5', python3: '3.13.0' } }),
      suggestions: { roles: [], missing: [] },
      jobs: [],
    },
  ];
}
