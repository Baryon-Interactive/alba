import type { EngineModule, EngineResult } from './types.ts';
import { ps, posixSystemPath } from '../commands.ts';
import { suggestion, type RoleSuggestion, type MissingItem } from '../capabilities.ts';
import { unrealPlan, prepareInstall } from './unreal-install.ts';
import { wingetPlan, InstallRefused } from '../install.ts';

export const unreal: EngineModule = {
  id: 'unreal',
  command(os) {
    if (os === 'windows') return ps([
      "$ErrorActionPreference='SilentlyContinue'",
      "$ue=@(); $uba=$false; Get-ChildItem 'HKLM:\\SOFTWARE\\EpicGames\\Unreal Engine' | %{$ue+=$_.PSChildName; $d=(Get-ItemProperty $_.PSPath).InstalledDirectory; if($d -and (Test-Path (Join-Path $d 'Engine\\Binaries\\Win64\\UnrealBuildAccelerator\\x64\\UbaAgent.exe'))){$uba=$true}}",
      "Get-ChildItem \"$env:ProgramFiles\\Epic Games\" -Directory -Filter 'UE_*' | %{$ue+=$_.Name.Substring(3); if(Test-Path (Join-Path $_.FullName 'Engine\\Binaries\\Win64\\UnrealBuildAccelerator\\x64\\UbaAgent.exe')){$uba=$true}}",
      "if(Get-Process -Name UbaAgent){$uba=$true}",
      "$vw=\"${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe\"; $vs=@(); if(Test-Path $vw){$vs=@(& $vw -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion)}",
      "$fx=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | %{$_.DeviceID}); $ts=@(); foreach($d in $fx){$ts+=@(Get-ChildItem \"$d\\BuildTools\\VC\\Tools\\MSVC\",\"$d\\Program Files*\\Microsoft Visual Studio\\*\\*\\VC\\Tools\\MSVC\" -Directory | %{$_.Name})}",
      "$sdk=@(Get-ChildItem \"${env:ProgramFiles(x86)}\\Windows Kits\\10\\Include\" -Directory | %{$_.Name})",
      '@{versions=@($ue|Sort-Object -Unique); uba=$uba; msvc=$vs; toolsets=@($ts|Sort-Object -Unique); sdk=$sdk} | ConvertTo-Json -Depth 4 -Compress',
    ].join('\n'));
    const roots = os === 'macos' ? '"$(dirname "$HOME")/Shared/Epic Games"/UE_* /Applications/UE_*' : `"$HOME"/UnrealEngine* ${posixSystemPath('opt', 'UnrealEngine*')} ${posixSystemPath('opt', 'UnrealEngine', 'UE_*')}`;
    return ['sh', '-c', `for d in ${roots}; do
[ -f "$d/Engine/Build/Build.version" ] || continue
printf 'version\\t%s\\n' "$(tr -d '\\n' < "$d/Engine/Build/Build.version" | sed -E 's/.*"MajorVersion"[[:space:]]*:[[:space:]]*([0-9]+).*"MinorVersion"[[:space:]]*:[[:space:]]*([0-9]+).*"PatchVersion"[[:space:]]*:[[:space:]]*([0-9]+).*/\\1.\\2.\\3/')"
done
printf 'end\\n'`];
  },
  parse(output, os): EngineResult {
    if (os !== 'windows') {
      if (!output.split(/\r?\n/).includes('end')) throw new Error('Incomplete engine scan.');
      return { versions: output.split(/\r?\n/).filter(l => l.startsWith('version\t')).map(l => l.slice(8)).filter(v => /^\d+\.\d+/.test(v)), features: {}, unsupported: ['MSVC and Windows SDK detection is supported only on Windows.', 'UBA detection and compile-helper suggestions are supported only on Windows.', 'Engine copying is supported only between Windows hosts.'] };
    }
    const raw = JSON.parse(output);
    const list = (value: unknown): string[] => (Array.isArray(value) ? value : value == null ? [] : [value]).filter((v): v is string => typeof v === 'string' && !!v.trim());
    const msvc = list(raw.msvc), toolsets = list(raw.toolsets);
    return { versions: list(raw.versions).sort(), features: { UBA: raw.uba === true ? ['installed'] : [], MSVC: msvc.length ? msvc : toolsets.map(v => 'toolset ' + v), 'Windows SDK': list(raw.sdk).sort() } };
  },
  suggest(os, result) {
    const roles: RoleSuggestion[] = [], missing: MissingItem[] = [];
    if (result.error) return { roles, missing };
    const v = result.versions.at(-1);
    if (os === 'windows') {
      const msvc = result.features.MSVC ?? [], sdk = result.features['Windows SDK'] ?? [];
      const gaps = [[!v, 'Unreal Engine', 'unreal'], [!msvc.length, 'MSVC C++ build tools (Visual Studio or Build Tools)', 'msvc'], [!sdk.length, 'Windows SDK', 'windows-sdk']] as const;
      for (const [gap, what, item] of gaps) if (gap) missing.push({ what, item, for: 'package' });
      if (!missing.length) roles.push(suggestion('package', 'Unreal Engine {ue}, MSVC {msvc} and Windows SDK {sdk} are installed.', { ue: v!, msvc: msvc[0], sdk: sdk.at(-1)! }));
      if (result.features.UBA?.length) roles.push(suggestion('compile-helper', 'The UBA agent that comes with Unreal Engine is installed.'));
      else missing.push({ what: 'Unreal Engine (brings the UBA agent)', for: 'compile-helper', item: 'unreal' });
    } else if (v) roles.push(suggestion('package', 'Unreal Engine {version} is installed.', { version: v }));
    else missing.push({ what: 'Unreal Engine', for: 'package' });
    return { roles, missing };
  },
  installItems: ['unreal', 'msvc', 'windows-sdk'],
  installPlan(machine, item) {
    if (machine.os !== 'windows') throw new InstallRefused('Unreal Engine installation requires the engine vendor tools on this platform.');
    if (item === 'unreal') return unrealPlan(machine, {});
    return wingetPlan(machine, item, item === 'msvc' ? { id: 'Microsoft.VisualStudio.2022.BuildTools', title: 'Visual Studio 2022 Build Tools (C++ workload and Windows SDK)', estimate: 'about 8-10 GB, 20-40 minutes', override: '--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' } : { id: 'Microsoft.WindowsSDK.10.0.26100', title: 'Windows SDK 10.0.26100', estimate: 'about 3 GB, 10-20 minutes' });
  },
  prepareInstall(machine, item, opts) { return item === 'unreal' ? prepareInstall(machine, item, opts) : Promise.resolve(this.installPlan!(machine, item, opts)); },
};
