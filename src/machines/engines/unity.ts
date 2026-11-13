import type { EngineModule } from './types.ts';
import { ps, posixSystemPath } from '../commands.ts';
import { parseEditor, editorSuggestions } from './editor.ts';

export const unity: EngineModule = {
  id: 'unity', parse: parseEditor, suggest: editorSuggestions('Unity'),
  command(os) {
    if (os === 'windows') return ps(`$ErrorActionPreference='SilentlyContinue'
Get-ChildItem "$env:ProgramFiles\\Unity\\Hub\\Editor" -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Editor\\Unity.exe') } | ForEach-Object { $_.Name }
Write-Output 'end'`);
    const roots = os === 'macos' ? '/Applications/Unity/Hub/Editor/*' : `"$HOME"/Unity/Hub/Editor/* ${posixSystemPath('opt', 'unity', 'Hub', 'Editor', '*')}`;
    const binary = os === 'macos' ? 'Unity.app/Contents/MacOS/Unity' : 'Editor/Unity';
    return ['sh', '-c', `for d in ${roots}; do [ -f "$d/${binary}" ] && basename "$d"; done; printf 'end\\n'`];
  },
};
