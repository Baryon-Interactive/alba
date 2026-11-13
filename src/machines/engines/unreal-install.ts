import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ps, psQuote, onMachine } from '../commands.ts';
import type { Machine } from '../config.ts';
import { InstallRefused, type InstallPlan, type PrepareInstallOptions } from '../install.ts';

/** Where Unreal Engine is installed on the alba host (registry first, then the default folder). */
const ueSourceScript = (version: string) => `$v=${psQuote(version)}
$d=(Get-ItemProperty ("HKLM:\\SOFTWARE\\EpicGames\\Unreal Engine\\" + $v) -ErrorAction SilentlyContinue).InstalledDirectory
if (-not $d) { $d=Join-Path $env:ProgramFiles ("Epic Games\\UE_" + $v) }
if (-not (Test-Path (Join-Path $d 'Engine\\Binaries\\Win64'))) { Write-Output "Unreal Engine $v is not installed on this computer."; exit 3 }
Write-Output $d
Write-Output ((Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB)`;

/** `parts`: paths under the engine folder, split into groups that are copied side by side. */
export interface UnrealSource { version: string; dir: string; size_gb?: number; parts?: string[][] }

/** Unreal Engine from the Epic launcher needs a sign-in and a window, so alba copies the engine installed on this computer instead. */
export function unrealPlan(machine: Machine, opts: { ueSource?: UnrealSource; dest?: string }): InstallPlan {
  if ('local' in machine.connect) throw new InstallRefused('Install Unreal Engine on this computer with the Epic Games Launcher.');
  if (process.platform !== 'win32') throw new InstallRefused('Copying Unreal Engine needs an Alba host on Windows with the engine installed.');
  const src = opts.ueSource;
  if (!src) throw new InstallRefused('Unreal Engine is not installed on this computer, so there is nothing to copy. Install it on the target with the Epic Games Launcher.');
  const dest = opts.dest;
  if (!dest || !/^[A-Za-z]:\\[^"']+$/.test(dest)) throw new InstallRefused('No drive on the target has room for the engine.');
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot) throw new InstallRefused('Windows system directory is unavailable.');
  const tar = path.win32.join(systemRoot, 'System32', 'tar.exe');
  const register = `$ErrorActionPreference='Stop'
$k='HKLM:\\SOFTWARE\\EpicGames\\Unreal Engine\\${src.version}'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name InstalledDirectory -Value ${psQuote(dest)}
$pre=Join-Path ${psQuote(dest)} 'Engine\\Extras\\Redist\\en-us\\UEPrereqSetup_x64.exe'
if (Test-Path $pre) { $p=Start-Process -FilePath $pre -ArgumentList '/quiet','/norestart' -WindowStyle Hidden -Wait -PassThru; Write-Output ('Prerequisites exit code ' + $p.ExitCode) }
Write-Output ('Unreal Engine ${src.version} registered at ' + ${psQuote(dest)})`;
  return {
    machine: machine.id, item: 'unreal', title: `Unreal Engine ${src.version} (copied from this computer)`,
    estimate: `${src.size_gb ? `about ${Math.round(src.size_gb)} GB` : 'tens of GB'}; on a gigabit network roughly ${src.size_gb ? Math.max(5, Math.round(src.size_gb / 6)) : 'tens of'} minutes`,
    notes: ['The Epic Games Launcher needs a sign-in and a window, so alba copies the engine installed on this computer over SSH instead.',
      `It goes to ${dest} (the drive with the most free space), is registered for Unreal Engine ${src.version}, and the engine prerequisites are installed quietly.`,
      'The Launcher on that machine will not list it; projects and builds find it through the registry.',
      'Use it under your own Unreal Engine licence. The login must be an administrator.'],
    lock: 'copy-unreal',
    display: [`mkdir "${dest}"`, `${src.parts?.length ?? 1} streams side by side, each: tar -czf - -C "${src.dir}" <relative source paths>  |  ssh ${'ssh' in machine.connect ? machine.connect.ssh : ''} tar -xf - -C "${dest}"`,
      `register HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${src.version} → ${dest}`, 'UEPrereqSetup_x64.exe /quiet /norestart'],
    steps: [
      { label: 'Create the folder', argv: onMachine(machine, ps(`New-Item -ItemType Directory -Force -Path ${psQuote(dest)} | Out-Null; if (Test-Path ${psQuote(dest)}) { Write-Output 'The folder already exists; files are overwritten.' }`)) },
      { label: 'Copy the engine', pipes: (src.parts?.length ? src.parts : [['']]).map(group => ({
        from: [tar, '-czf', '-', '-C', src.dir, ...group.map(p => p || '.')],
        to: onMachine(machine, ['tar', '-xf', '-', '-C', `"${dest}"`]) })) },
      { label: 'Register and install prerequisites', argv: onMachine(machine, ps(register)) },
    ],
  };
}

let ueCache: { version: string; at: number; source?: UnrealSource } | undefined;
/** Builds the plan, first looking up what only the hosts can tell (the engine to copy, its size, the target drive). */
export async function prepareInstall(machine: Machine, item: string, opts: PrepareInstallOptions): Promise<InstallPlan> {
  if (item !== 'unreal' || machine.os !== 'windows' || 'local' in machine.connect || process.platform !== 'win32') return unrealPlan(machine, {});
  const version = [...(opts.hostCaps?.engines?.unreal?.versions ?? [])].sort().at(-1);
  if (!version) return unrealPlan(machine, {});
  if (!ueCache || ueCache.version !== version || Date.now() - ueCache.at > 3600000) {
    let source: UnrealSource | undefined;
    try {
      const [dir, size] = (await opts.run(unrealSourceCommand(version), 300)).trim().split(/\r?\n/).map(s => s.trim());
      if (dir && /^[A-Za-z]:\\/.test(dir)) source = { version, dir, ...(Number(size) > 0 ? { size_gb: Number(size) } : {}), parts: splitParts(dir, 8) };
    } catch { /* not installed here */ }
    ueCache = { version, at: Date.now(), source };
  }
  const source = ueCache.source;
  return unrealPlan(machine, { ueSource: source, dest: source ? unrealDest(opts.disks ?? [], version, source.size_gb ?? 80) : undefined });
}

/** Splits a folder into `n` groups of paths for parallel copies. Folders holding more than a 1/(4n) share of the files are
 * opened up further, then the pieces are dealt out largest first by file count so the groups finish at about the same time. */
export function splitParts(dir: string, n: number): string[][] {
  type Node = { rel: string; files: number; kids?: Node[] };
  const walk = (rel: string): Node => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { /* unreadable: copied as a whole */ }
    const kids = entries.map(e => (e.isDirectory() ? walk(rel ? `${rel}/${e.name}` : e.name) : { rel: rel ? `${rel}/${e.name}` : e.name, files: 1 }));
    return { rel, files: kids.reduce((s, k) => s + k.files, 0) || 1, kids };
  };
  const root = walk('');
  const limit = Math.max(1, root.files / (4 * n));
  const units: Node[] = [];
  const open = (node: Node) => { if (node.kids?.length && (node.files > limit || !node.rel)) node.kids.forEach(open); else units.push(node); };
  open(root);
  const groups = Array.from({ length: n }, () => ({ files: 0, parts: [] as string[] }));
  for (const u of units.sort((a, b) => b.files - a.files)) { const g = groups.reduce((a, b) => (b.files < a.files ? b : a)); g.parts.push(u.rel); g.files += u.files; }
  return groups.filter(g => g.parts.length).map(g => g.parts);
}

/** The script that finds the engine to copy on the alba host; prints its folder, then its size in GB. */
export const unrealSourceCommand = (version: string) => ps(ueSourceScript(version));
/** The target folder for a copied engine: the fixed drive with the most free space that holds the engine plus 20 GB. */
export function unrealDest(disks: { mount: string; free_gb: number }[], version: string, sizeGb: number): string | undefined {
  const drive = disks.filter(d => /^[A-Za-z]:$/.test(d.mount) && d.free_gb >= sizeGb + 20).sort((a, b) => b.free_gb - a.free_gb)[0];
  return drive ? `${drive.mount}\\Epic Games\\UE_${version}` : undefined;
}
