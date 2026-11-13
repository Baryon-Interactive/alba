# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/window_shot.ps1 -Exe <game exe> -Out <png> [-Wait 25] [-GameArgs "..."]
param([string]$Exe, [string]$Out, [int]$Wait = 20, [string]$GameArgs = "-windowed -ResX=1600 -ResY=900")
# Starts the game, waits, takes its main window with PrintWindow (it works when another window covers it; the window is not
# brought to the front, so a person working on this desktop keeps the focus), then stops only the processes it started.
# Exit code: 0 when the picture was saved, 1 otherwise (no window, PrintWindow failed).
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
public struct RECT { public int L, T, R, B; } }
"@
$p = Start-Process -FilePath $Exe -ArgumentList $GameArgs -PassThru
$started = $p.StartTime
Start-Sleep -Seconds $Wait
# The game, and the processes it started (a launcher's game): children of its pid created after it, so a reused pid is not taken.
$procs = @($p) + @(Get-CimInstance Win32_Process | ? { $_.ParentProcessId -eq $p.Id -and $_.CreationDate -ge $started } | % { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
$win = $procs | ? { $_ -and -not $_.HasExited -and $_.MainWindowHandle -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
$code = 1
if (-not $win) { "no window: the game showed none within $Wait s" } else {
  $r = New-Object W+RECT; [W]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null
  $w = $r.R - $r.L; $h = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # PW_RENDERFULLCONTENT (2): the window's own content. No copy from the screen: that would take whatever window is on top.
  $hdc = $g.GetHdc(); $ok = [W]::PrintWindow($win.MainWindowHandle, $hdc, 2); $g.ReleaseHdc($hdc)
  if ($ok) { $bmp.Save($Out); "saved $Out ${w}x${h} from pid $($win.Id) (PrintWindow)"; $code = 0 }
  else { "PrintWindow failed for pid $($win.Id); nothing saved" }
  $g.Dispose(); $bmp.Dispose()
}
foreach ($q in $procs) { if ($q) { Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue } }
exit $code
