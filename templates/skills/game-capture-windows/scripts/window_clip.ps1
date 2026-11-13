# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/window_clip.ps1 -Exe <game exe> -Out <mp4>
#          [-Wait 20] [-Seconds 8] [-Fps 10] [-GameArgs "..."]
# Starts the game, waits, records the game window itself with PrintWindow frame by frame (works when other windows cover
# it; ffmpeg gdigrab by title records black for a DirectX 12 window, and a desktop region picks up whatever window is on
# top), joins the frames into an MP4 with ffmpeg, then stops only the processes it started.
# Exit code: 0 when the clip was saved, 1 otherwise (no window, PrintWindow failed for every frame, ffmpeg failed).
param([string]$Exe, [string]$Out, [int]$Wait = 20, [double]$Seconds = 8, [int]$Fps = 10,
      [string]$GameArgs = "-windowed -ResX=1600 -ResY=900")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WC { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
public struct RECT { public int L, T, R, B; } }
"@
$p = Start-Process -FilePath $Exe -ArgumentList $GameArgs -PassThru
$started = $p.StartTime
Start-Sleep -Seconds $Wait
# The game, and the processes it started: children of its pid created after it, so a reused pid is not taken.
$procs = @($p) + @(Get-CimInstance Win32_Process | ? { $_.ParentProcessId -eq $p.Id -and $_.CreationDate -ge $started } | % { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
$win = $procs | ? { $_ -and -not $_.HasExited -and $_.MainWindowHandle -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
$code = 1
if (-not $win) { "no window: the game showed none within $Wait s" } else {
  # A folder of its own for each clip, so frames of an earlier clip are never joined into this one.
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("alba-clip-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Force $dir | Out-Null
  try {
    $r = New-Object WC+RECT; [WC]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null
    $w = ($r.R - $r.L) - (($r.R - $r.L) % 2); $h = ($r.B - $r.T) - (($r.B - $r.T) % 2)
    $count = [int]($Seconds * $Fps); $interval = 1000.0 / $Fps; $sw = [System.Diagnostics.Stopwatch]::StartNew(); $ok = 0
    for ($i = 0; $i -lt $count; $i++) {
      $bmp = New-Object System.Drawing.Bitmap $w, $h; $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc(); if ([WC]::PrintWindow($win.MainWindowHandle, $hdc, 2)) { $ok++ }; $g.ReleaseHdc($hdc)
      $bmp.Save((Join-Path $dir ("f{0:D4}.png" -f $i))); $g.Dispose(); $bmp.Dispose()
      $next = ($i + 1) * $interval; $left = $next - $sw.ElapsedMilliseconds; if ($left -gt 0) { Start-Sleep -Milliseconds ([int]$left) }
    }
    $real = $count / ($sw.ElapsedMilliseconds / 1000.0)
    if ($ok -eq 0) { "PrintWindow failed for every frame of pid $($win.Id); nothing saved" }
    else {
      & ffmpeg -v error -y -framerate ([math]::Round($real, 2)) -i (Join-Path $dir "f%04d.png") -c:v libx264 -pix_fmt yuv420p $Out
      if ($LASTEXITCODE -ne 0) { "ffmpeg failed (exit $LASTEXITCODE); nothing saved" }
      else { "saved $Out ${w}x${h} frames=$count printwindow_ok=$ok effective_fps=" + [math]::Round($real, 1); $code = 0 }
    }
  } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
}
foreach ($q in $procs) { if ($q) { Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue } }
exit $code
