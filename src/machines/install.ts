import { ps, psQuote, shQuote, onMachine, posixSystemPath } from './commands.ts';
import type { Machine } from './config.ts';
import type { Capabilities } from './capabilities.ts';
import { engineModule } from './engines/index.ts';

/** Something the capability scan found missing that alba can install. */
export type InstallItem = string;
export const INSTALL_ITEMS: InstallItem[] = ['git', 'cmake', 'compiler', 'python', 'node', 'opencode', 'claude-code'];

/** One step runs a program on the alba host (for a remote machine that program is ssh), or pipes one program into another. */
export type InstallStep =
  | { label: string; argv: string[] }
  | { label: string; pipe: { from: string[]; to: string[] } }
  | { label: string; pipes: { from: string[]; to: string[] }[] };
export interface InstallPlan {
  machine: string; item: InstallItem; title: string;
  /** Rough size and time, for the confirmation. */
  estimate: string;
  /** What the person should know before agreeing (admin rights, licence terms, what is not done). */
  notes: string[];
  /** The commands as a person reads them; `steps` are what actually runs. */
  display: string[];
  steps: InstallStep[];
  /** Exit codes other than 0 that mean "nothing to do". */
  ok_codes?: number[];
  /** Jobs with the same lock on one machine run one at a time (installers fight; a file copy does not). Default `install`. */
  lock?: string;
}
export class InstallRefused extends Error {}

const WINGET: Partial<Record<InstallItem, { id: string; title: string; estimate: string; override?: string; scope?: 'machine' }>> = {
  python: { id: 'Python.Python.3.13', title: 'Python 3.13', estimate: 'about 100 MB, a few minutes', scope: 'machine' },
  node: { id: 'OpenJS.NodeJS.LTS', title: 'Node.js LTS (with npm)', estimate: 'about 100 MB, a few minutes', scope: 'machine' },
  git: { id: 'Git.Git', title: 'Git (with Git LFS)', estimate: 'about 350 MB, a few minutes' },
  cmake: { id: 'Kitware.CMake', title: 'CMake', estimate: 'about 120 MB, a few minutes' },
  compiler: { id: 'LLVM.LLVM', title: 'Clang C++ compiler', estimate: 'about 1 GB, a few minutes' },
};
const NPM: Partial<Record<InstallItem, { pkg: string; title: string; bin: string }>> = {
  opencode: { pkg: 'opencode-ai', title: 'opencode (worker command line)', bin: 'opencode' },
  'claude-code': { pkg: '@anthropic-ai/claude-code', title: 'Claude Code (worker command line)', bin: 'claude' },
};
const APT: Partial<Record<InstallItem, { apt: string[]; dnf: string[]; brew?: string[]; title: string }>> = {
  python: { apt: ['python3'], dnf: ['python3'], brew: ['python'], title: 'Python 3' },
  node: { apt: ['nodejs', 'npm'], dnf: ['nodejs', 'npm'], brew: ['node'], title: 'Node.js and npm' },
  git: { apt: ['git', 'git-lfs'], dnf: ['git', 'git-lfs'], brew: ['git', 'git-lfs'], title: 'Git and Git LFS' },
  cmake: { apt: ['cmake', 'ninja-build'], dnf: ['cmake', 'ninja-build'], brew: ['cmake', 'ninja'], title: 'CMake and Ninja' },
  compiler: { apt: ['build-essential'], dnf: ['gcc-c++', 'make'], brew: ['llvm'], title: 'C++ compiler' },
};
// Winget answers "already installed" and "no newer version" with these codes.
const WINGET_DONE = [-1978335189, -1978335135];

/** Runs winget on the machine. In an SSH session Windows refuses to start the Store-packaged winget ("Access is denied"),
 * so there it runs through a one-off scheduled task as SYSTEM (removed afterwards) whose log is streamed back. */
const wingetScript = (id: string, override: string | undefined, viaTask: boolean, scope?: 'machine') => {
  const args = `install --id ${psQuote(id)} --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity --no-upgrade${scope ? ` --scope ${scope}` : ''}${override ? ` --override ${psQuote(override)}` : ''}`;
  const find = `$p=Get-AppxPackage Microsoft.DesktopAppInstaller -AllUsers -ErrorAction SilentlyContinue | Sort-Object Version | Select-Object -Last 1
$w=if ($p) { Join-Path $p.InstallLocation 'winget.exe' } else { (Get-Command winget -ErrorAction SilentlyContinue).Source }
if (-not $w -or -not (Test-Path $w)) { Write-Output 'winget is not available on this machine. Install App Installer from the Microsoft Store, then retry.'; exit 3 }`;
  if (!viaTask) return `$ProgressPreference='SilentlyContinue'
${find.replace('-AllUsers ', '')}
& $w ${args} 2>&1 | ForEach-Object { "$_" }
$code=$LASTEXITCODE
if (@(-1978335189, -1978335135) -contains $code) { Write-Output 'Already installed; left as it is.'; exit 0 }
exit $code`;
  const inner = `$ProgressPreference='SilentlyContinue'; $env:Path='__PATHS__;' + $env:Path
& '__W__' ${args} 2>&1 | Out-File -FilePath '__LOG__' -Encoding utf8
exit $LASTEXITCODE`;
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
${find}
$dir=Join-Path $env:ProgramData 'alba'; New-Item -ItemType Directory -Force $dir | Out-Null
$name='alba-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8); $log=Join-Path $dir "$name.log"
# As SYSTEM, winget fails with STATUS_DLL_NOT_FOUND unless its framework packages (VCLibs, UI.Xaml) are on PATH.
$deps=@(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object { ($_.Name -like 'Microsoft.VCLibs.140.00*' -or $_.Name -like 'Microsoft.UI.Xaml*') -and $_.Architecture -eq 'X64' } | ForEach-Object { $_.InstallLocation })
$paths=((@(Split-Path $w) + $deps) -join ';')
$inner=${psQuote(inner)}.Replace('__W__', $w).Replace('__LOG__', $log).Replace('__PATHS__', $paths)
$enc=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -EncodedCommand ' + $enc)
$pr=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $a -Principal $pr -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $name; Start-Sleep -Seconds 2
  $shown=0
  do {
    Start-Sleep -Seconds 2
    $state=(Get-ScheduledTask -TaskName $name).State
    if (Test-Path $log) { $fs=[IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd(); $fs.Close(); if ($text.Length -gt $shown) { [Console]::Out.Write($text.Substring($shown)); $shown=$text.Length } }
  } while ($state -eq 'Running' -or $state -eq 'Queued')
  $code=[long](Get-ScheduledTaskInfo -TaskName $name).LastTaskResult; if ($code -gt 2147483647) { $code -= 4294967296 }
} finally { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Remove-Item $log -ErrorAction SilentlyContinue }
Write-Output "winget exit code $code"
if (@(-1978335189, -1978335135) -contains $code) { Write-Output 'Already installed; left as it is.'; exit 0 }
if ($code -eq 0) { exit 0 } else { exit 1 }
} catch { Write-Output $_.Exception.Message; exit 1 }`;
};

const posixScript = (pkgs: { apt: string[]; dnf: string[]; brew?: string[] }) => `set -e
if command -v brew >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then ${pkgs.brew ? `brew install ${pkgs.brew.join(' ')}; exit 0` : `echo 'Install the Xcode command line tools: xcode-select --install'; exit 3`}; fi
if ! sudo -n true 2>/dev/null; then echo 'Installing needs sudo without a password prompt for this login. Run this on the machine yourself:'; if command -v apt-get >/dev/null 2>&1; then echo "  sudo apt-get install -y ${pkgs.apt.join(' ')}"; else echo "  sudo dnf install -y ${pkgs.dnf.join(' ')}"; fi; exit 3; fi
if command -v apt-get >/dev/null 2>&1; then sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ${pkgs.apt.join(' ')}
elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y -q ${pkgs.dnf.join(' ')}
else echo 'No apt-get or dnf on this machine.'; exit 3; fi`;

/** The install plan for a generic item or an explicitly selected module item. */
export function installPlan(machine: Machine, item: string, opts: { caps?: Capabilities | null } = {}): InstallPlan {
  const module = machine.engine ? engineModule(machine.engine) : undefined;
  if (module?.installItems?.includes(item) && module.installPlan) return module.installPlan(machine, item, opts);
  if (!(INSTALL_ITEMS as string[]).includes(item)) throw new InstallRefused(`Unknown item "${item}". Items: ${INSTALL_ITEMS.join(', ')}.`);
  const it = item as InstallItem;
  if (NPM[it]) return npmPlan(machine, it, NPM[it]!);
  if (machine.os === 'windows') {
    return wingetPlan(machine, it, WINGET[it]!);
  }
  const p = APT[it];
  if (!p) throw new InstallRefused(`${it} cannot be installed on ${machine.os}.`);
  if (machine.os === 'macos') return { machine: machine.id, item: it, title: p.title, estimate: 'a few minutes',
    notes: ['Uses Homebrew on the target machine. Afterwards Alba scans the machine again.'],
    display: [`brew install ${p.brew!.join(' ')}`],
    steps: [{ label: `Install ${p.title}`, argv: onMachine(machine, ['sh', '-c', `export PATH="${posixSystemPath('opt', 'homebrew', 'bin')}:/usr/local/bin:$PATH"; command -v brew >/dev/null 2>&1 || { echo 'Homebrew is not installed. Install it first, then retry.'; exit 3; }; brew install ${p.brew!.join(' ')}`]) }] };
  return {
    machine: machine.id, item: it, title: p.title, estimate: 'a few minutes',
    notes: ['Linux: uses apt-get or dnf through sudo, and only when sudo needs no password for this login; otherwise it prints the command to run yourself.',
      'Afterwards alba scans the machine again.'],
    display: [`sudo apt-get install -y ${p.apt.join(' ')}`, `(or) sudo dnf install -y ${p.dnf.join(' ')}`],
    steps: [{ label: `Install ${p.title}`, argv: onMachine(machine, ['sh', '-c', posixScript(p)]) }],
  };
}


export interface PrepareInstallOptions { caps?: Capabilities | null; disks?: { mount: string; free_gb: number }[]; hostCaps?: Capabilities | null; run: (argv: string[], seconds: number) => Promise<string> }
export async function prepareInstall(machine: Machine, item: string, opts: PrepareInstallOptions): Promise<InstallPlan> {
  const module = machine.engine ? engineModule(machine.engine) : undefined;
  if (module?.installItems?.includes(item) && module.prepareInstall) return module.prepareInstall(machine, item, opts);
  return installPlan(machine, item, opts);
}

export interface WingetPackage { id: string; title: string; estimate: string; override?: string; scope?: 'machine' }
export function wingetPlan(machine: Machine, item: string, w: WingetPackage): InstallPlan {
        const script = wingetScript(w.id, w.override, !('local' in machine.connect), w.scope);
    return {
      machine: machine.id, item, title: w.title, estimate: w.estimate, ok_codes: WINGET_DONE,
      notes: ['Runs winget on the machine. Over SSH it runs as SYSTEM through a one-off scheduled task, removed afterwards; the login must be an administrator (the setup script authorizes an administrator key).',
        'Starting it accepts the package\'s licence and the winget source terms.', 'Already installed counts as success. Afterwards alba scans the machine again.'],
      display: [`winget install --id ${w.id} --exact --silent --accept-source-agreements --accept-package-agreements${w.scope ? ` --scope ${w.scope}` : ''}${w.override ? ` --override "${w.override}"` : ''}`],
      steps: [{ label: `Install ${w.title}`, argv: onMachine(machine, ps(script)) }],
    };
}

/** A worker command line from npm, for the login Alba uses on the machine. Needs Node.js there (an install item too). */
function npmPlan(machine: Machine, item: InstallItem, p: { pkg: string; title: string; bin: string }): InstallPlan {
  const windows = machine.os === 'windows';
  const script = windows
    ? `$npm = @("$env:ProgramFiles\\nodejs\\npm.cmd", (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $npm) { Write-Output 'Node.js is not installed on this machine; install the node item first.'; exit 3 }
& $npm install -g --no-fund --no-audit ${psQuote(p.pkg)} 2>&1 | ForEach-Object { [string]$_ }
$code = $LASTEXITCODE
$bin = Join-Path (& $npm prefix -g) '${p.bin}.cmd'
if (Test-Path $bin) { Write-Output ('Installed: ' + $bin); & $bin --version 2>&1 | Select-Object -First 1 }
exit $code`
    : `export PATH="${posixSystemPath('opt', 'homebrew', 'bin')}:/usr/local/bin:$HOME/.local/bin:$PATH"
command -v npm >/dev/null || { echo 'Node.js is not installed on this machine; install the node item first.'; exit 3; }
npm install -g --no-fund --no-audit --prefix "$HOME/.local" ${shQuote(p.pkg)} && echo "Installed: $HOME/.local/bin/${p.bin}" && "$HOME/.local/bin/${p.bin}" --version | head -1`;
  return {
    machine: machine.id, item, title: p.title, estimate: 'about 100-300 MB, a few minutes',
    notes: [`Runs npm install -g ${p.pkg} as the login Alba uses on the machine (${windows ? 'its own npm folder under AppData' : 'under ~/.local'}).`,
      'A worker on that machine names this program in its launch settings; its sign-in or gateway key is set up there by a person.'],
    display: [windows ? `npm install -g ${p.pkg}` : `npm install -g --prefix ~/.local ${p.pkg}`],
    steps: [{ label: `Install ${p.title}`, argv: onMachine(machine, windows ? ps(script) : ['sh', '-c', script]) }],
  };
}
