import type { Machine, RoleRequirements } from './config.ts';
import { INSTALL_ITEMS } from './install.ts';
import { engineModule, type EngineResult } from './engines/index.ts';
import { posixSystemPath } from './commands.ts';

/** What a machine has: read once a day (and on demand), never a full process command line or environment. */
export interface Capabilities {
  at: string;
  error?: string;
  cpu?: string;
  cores?: number;
  threads?: number;
  ram_gb?: number;
  os_version?: string;
  gpus: { name: string; vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'; vram_gb?: number }[];
  /** Present only for explicitly selected engine modules. */
  engines?: Record<string, EngineResult>;
  /** Tool name → version (first version-looking token of its version output). */
  tools: Record<string, string>;
}
/** `reason` is `key` with `vars` filled in; the board translates `key`. */
export interface RoleSuggestion { role: string; reason: string; key: string; vars: Record<string, string | number> }
export interface MissingItem { what: string; for: string; item?: string }
export interface Suggestions { roles: RoleSuggestion[]; missing: MissingItem[] }

const TOOLS = ['git', 'git-lfs', 'python', 'cmake', 'ninja', 'node', 'dotnet', 'cl', 'gcc', 'clang', 'docker', 'opencode', 'claude'];
const POSIX_TOOLS = ['git', 'git-lfs', 'python3', 'cmake', 'ninja', 'node', 'dotnet', 'gcc', 'clang', 'docker', 'opencode', 'claude'];

export function vendorOf(name: string): Capabilities['gpus'][number]['vendor'] {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (/\bamd\b|radeon|ati\b/i.test(name)) return 'amd';
  if (/intel/i.test(name)) return 'intel';
  if (/apple/i.test(name)) return 'apple';
  return 'other';
}
const version = (s: string) => /\d+(?:\.\d+)+/.exec(s)?.[0] ?? s.trim().slice(0, 40);

/** One read-only command per OS. Windows prints one JSON object; Linux and macOS print tab-separated lines ending in `end`. */
export function capabilityCommand(os: Machine['os']): string[] {
  if (os === 'windows') {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8",
      '$c=@(Get-CimInstance Win32_Processor); $o=Get-CimInstance Win32_OperatingSystem',
      // Real VRAM sits in the display class keys; Win32_VideoController.AdapterRAM stops at 4 GB.
      "$g=@(Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ?{$_.DriverDesc} | %{@{name=$_.DriverDesc; vram=$_.'HardwareInformation.qwMemorySize'}})",
      'if(-not $g.Count){$g=@(Get-CimInstance Win32_VideoController | %{@{name=$_.Name; vram=$null}})}',
      `$t=@{}; foreach($n in @(${TOOLS.map(t => `'${t}'`).join(',')})){$x=Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\\WindowsApps\\*' } | Select-Object -First 1; if($x){$v=[string]$x.Version; if(-not $v -or $v -eq '0.0.0.0'){$v='installed'}; $t[$n]=$v}}`,
      '@{cpu=$c[0].Name; cores=($c|Measure-Object NumberOfCores -Sum).Sum; threads=($c|Measure-Object NumberOfLogicalProcessors -Sum).Sum; ram=$o.TotalVisibleMemorySize/1MB; os=$o.Caption+\' \'+$o.Version; gpus=$g; tools=$t} | ConvertTo-Json -Depth 4 -Compress',
    ].join('\n');
    return ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  // Tools often live outside the PATH of a non-interactive login: user bins, virtualenvs, /opt.
  const toolLoop = `PATH="$PATH:${posixSystemPath('opt', 'homebrew', 'bin')}:/usr/local/bin:$HOME/.local/bin:$HOME/bin:$HOME/.venv/bin:$HOME/venv/bin$(for d in "$HOME"/*/venv/bin "$HOME"/*/.venv/bin ${posixSystemPath('opt', '*', 'bin')}; do [ -d "$d" ] && printf ':%s' "$d"; done)"
for t in ${POSIX_TOOLS.join(' ')}; do if command -v "$t" >/dev/null 2>&1; then printf 'tool\\t%s\\t%s\\n' "$t" "$("$t" --version 2>&1 | head -n 1)"; fi; done`;
  const hw = os === 'linux' ? `printf 'cpu\\t%s\\n' "$(awk -F: '/model name/{sub(/^ +/,"",$2);print $2;exit}' /proc/cpuinfo)"
printf 'threads\\t%s\\n' "$(getconf _NPROCESSORS_ONLN)"
printf 'cores\\t%s\\n' "$(awk -F: '/^physical id/{p=$2}/^core id/{print p":"$2}' /proc/cpuinfo | sort -u | wc -l)"
awk '/MemTotal:/{printf "ram\\t%.3f\\n",$2/1048576}' /proc/meminfo
printf 'os\\t%s\\n' "$( . ${posixSystemPath('etc', 'os-release')} 2>/dev/null; echo "$PRETTY_NAME")"
if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | while IFS=, read -r n m; do printf 'gpu\\t%s\\t%s\\n' "$n" "$m"; done; fi
if command -v lspci >/dev/null 2>&1; then lspci 2>/dev/null | grep -Ei 'vga|3d controller|display' | sed 's/^[^:]*: //' | while read -r l; do printf 'pci\\t%s\\n' "$l"; done; fi`
    : `printf 'cpu\\t%s\\n' "$(sysctl -n machdep.cpu.brand_string)"
printf 'threads\\t%s\\n' "$(sysctl -n hw.logicalcpu)"
printf 'cores\\t%s\\n' "$(sysctl -n hw.physicalcpu)"
printf 'ram\\t%s\\n' "$(sysctl -n hw.memsize | awk '{printf "%.3f",$1/1073741824}')"
printf 'os\\t%s\\n' "macOS $(sw_vers -productVersion)"
system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print "pci\\t"$2}'`;
  return ['sh', '-c', `export LC_ALL=C\n${hw}\n${toolLoop}\nprintf 'end\\n'`];
}

/** Parses the scan output. Throws on output that is not a scan. */
export function parseCapabilities(output: string, at: string): Capabilities {
  const caps: Capabilities = { at, gpus: [], tools: {} };
  const text = output.trim();
  if (text.startsWith('{')) {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const list = (v: unknown): unknown[] => v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
    if (typeof raw.cpu === 'string') caps.cpu = raw.cpu.trim();
    if (typeof raw.cores === 'number') caps.cores = raw.cores;
    if (typeof raw.threads === 'number') caps.threads = raw.threads;
    if (typeof raw.ram === 'number') caps.ram_gb = Math.round(raw.ram * 10) / 10;
    if (typeof raw.os === 'string') caps.os_version = raw.os.trim();
    for (const g of list(raw.gpus) as { name?: unknown; vram?: unknown }[]) {
      if (typeof g?.name !== 'string' || !g.name.trim()) continue;
      const vram = typeof g.vram === 'number' && g.vram > 0 ? Math.round(g.vram / 2 ** 30 * 10) / 10 : undefined;
      if (!caps.gpus.some(x => x.name === g.name)) caps.gpus.push({ name: g.name.trim(), vendor: vendorOf(g.name), ...(vram ? { vram_gb: vram } : {}) });
    }
    if (raw.tools && typeof raw.tools === 'object') for (const [k, v] of Object.entries(raw.tools)) if (typeof v === 'string' && TOOLS.includes(k)) caps.tools[k] = v === 'installed' ? v : version(v);
    return caps;
  }
  const lines = text.split(/\r?\n/);
  if (!lines.includes('end')) throw new Error('Incomplete capability scan.');
  for (const line of lines) {
    const [kind, a = '', b = ''] = line.split('\t');
    if (kind === 'cpu' && a.trim()) caps.cpu = a.trim();
    if (kind === 'threads' && +a > 0) caps.threads = +a;
    if (kind === 'cores' && +a > 0) caps.cores = +a;
    if (kind === 'ram' && +a > 0) caps.ram_gb = Math.round(+a * 10) / 10;
    if (kind === 'os' && a.trim()) caps.os_version = a.trim();
    if (kind === 'gpu' && a.trim()) caps.gpus.push({ name: a.trim(), vendor: vendorOf(a), ...(+b > 0 ? { vram_gb: Math.round(+b / 1024 * 10) / 10 } : {}) });
    if (kind === 'pci' && a.trim()) {
      const name = a.trim();
      // nvidia-smi already named the NVIDIA cards with their memory.
      if (!(vendorOf(name) === 'nvidia' && caps.gpus.some(g => g.vendor === 'nvidia'))) caps.gpus.push({ name, vendor: vendorOf(name) });
    }
    if (kind === 'tool' && POSIX_TOOLS.includes(a)) caps.tools[a === 'python3' ? 'python' : a] = version(b);
  }
  return caps;
}

export const suggestion = (role: string, key: string, vars: Record<string, string | number> = {}): RoleSuggestion =>
  ({ role, key, vars, reason: key.replace(/\{(\w+)\}/g, (w, n: string) => (n in vars ? String(vars[n]) : w)) });

const discrete = (g: Capabilities['gpus'][number]) => (g.vendor === 'amd' || g.vendor === 'nvidia') && !/virtual|basic display|microsoft/i.test(g.name) && (g.vram_gb === undefined || g.vram_gb >= 3);

/** Roles the scan supports, with the reason, and what is missing for the roles it nearly supports. Timing baselines are never suggested: that needs a quiet machine, which a scan cannot see. */
export function suggestRoles(os: Machine['os'], caps: Capabilities | null | undefined, requirements: RoleRequirements = {}): Suggestions {
  const roles: RoleSuggestion[] = [], missing: MissingItem[] = [];
  if (!caps || caps.error) return { roles, missing };
  const threads = caps.threads ?? 0, ram = caps.ram_gb ?? 0;
  const compiler = !!(caps.tools.cl || caps.tools.gcc || caps.tools.clang);
  for (const [id, result] of Object.entries(caps.engines ?? {})) {
    const extra = engineModule(id)?.suggest(os, result);
    if (extra) { roles.push(...extra.roles); missing.push(...extra.missing); }
  }
  for (const [role, required] of Object.entries(requirements)) {
    if (threads < (required.min_threads ?? 0) || ram < (required.min_ram_gb ?? 0)) continue;
    const absent = required.tools.filter(tool => tool === 'compiler' ? !compiler : !caps.tools[tool === 'claude-code' ? 'claude' : tool]);
    if (!absent.length) roles.push(suggestion(role, 'Configured requirements met: {tools}; {threads} threads, {ram} GB of memory.', { tools: required.tools.join(', '), threads, ram }));
    else for (const tool of absent) missing.push({ what: tool === 'python' ? 'Python' : tool === 'cmake' ? 'CMake' : tool === 'compiler' ? 'a C++ compiler (gcc or clang)' : tool, for: role, ...(INSTALL_ITEMS.includes(tool) ? { item: tool } : {}) });
  }
  const gpu = caps.gpus.find(discrete);
  if (gpu) roles.push(gpu.vendor === 'amd'
    ? suggestion('gpu-qa', 'Discrete AMD graphics card {gpu} ({vram} GB): the AMD baseline.', { gpu: gpu.name, vram: gpu.vram_gb ?? '?' })
    : suggestion('gpu-qa', 'Discrete graphics card {gpu} ({vram} GB).', { gpu: gpu.name, vram: gpu.vram_gb ?? '?' }));
  if ((roles.some(r => r.role === 'package') || missing.some(m => m.for === 'package')) && !caps.tools.git) missing.push({ what: 'Git', for: 'package', item: 'git' });
  return { roles, missing };
}
