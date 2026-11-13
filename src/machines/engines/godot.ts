import type { EngineModule } from './types.ts';
import { ps, posixSystemPath } from '../commands.ts';
import { parseEditor, editorSuggestions } from './editor.ts';

export const godot: EngineModule = {
  id: 'godot', parse: parseEditor, suggest: editorSuggestions('Godot'),
  command(os) {
    if (os === 'windows') return ps(`$ErrorActionPreference='SilentlyContinue'
$bins=@(Get-Command godot,godot4 -CommandType Application | ForEach-Object { $_.Source })
$bins+=@(Get-ChildItem "$env:ProgramFiles\\Godot\\Godot*.exe","$env:LOCALAPPDATA\\Programs\\Godot\\Godot*.exe" -File | ForEach-Object { $_.FullName })
$bins | Sort-Object -Unique | ForEach-Object { & $_ --version }
Write-Output 'end'`);
    const extra = os === 'macos' ? '/Applications/Godot.app/Contents/MacOS/Godot "$HOME"/Applications/Godot.app/Contents/MacOS/Godot' : `${posixSystemPath('opt', 'godot', 'godot*')} /usr/local/bin/godot* "$HOME"/.local/bin/godot*`;
    return ['sh', '-c', `for n in godot godot4; do command -v "$n" >/dev/null 2>&1 && "$n" --version; done
for p in ${extra}; do [ -f "$p" ] && [ -x "$p" ] && "$p" --version; done
printf 'end\\n'`];
  },
};
