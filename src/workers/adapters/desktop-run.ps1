# Runs one command in the desktop session of the user logged on to this machine, waits for it, prints its output and exits
# with its exit code. Copied next to run.ps1 for a remote run; the worker finds it as $env:ALBA_DESKTOP_RUN. Windows PowerShell 5.1.
#
# Why: a process started over SSH runs in a session without a desktop. A program that opens a window or a GPU swap chain (a game
# capture, the Unreal editor) fails there (DXGI_ERROR_NOT_CURRENTLY_AVAILABLE). A scheduled task with an interactive principal runs
# in the logged-on user's own desktop session instead. It needs that user to be the one this script runs as, and to be logged on.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop-run.ps1 [-TimeoutMinutes 30] [-WorkingDirectory dir] -- <program> <arguments...>
# No param block: Windows PowerShell binds "-Anything" after "--" to this script's parameters, so the options are read by hand.
$TimeoutMinutes = 30; $WorkingDirectory = ''; $Command = @()
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '--') { $Command = @($args | Select-Object -Skip ($i + 1) | ForEach-Object { [string]$_ }); break }
  elseif ($a -eq '-TimeoutMinutes') { $TimeoutMinutes = [int]$args[++$i] }
  elseif ($a -eq '-WorkingDirectory') { $WorkingDirectory = [string]$args[++$i] }
  else { $Command = @($args | Select-Object -Skip $i | ForEach-Object { [string]$_ }); break }
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Stop-Here([string]$text, [int]$code = 2) { [Console]::Error.WriteLine("[desktop-run] $text"); exit $code }

if (-not $Command.Count) { Stop-Here 'usage: desktop-run.ps1 [-TimeoutMinutes 30] [-WorkingDirectory dir] -- <program> <arguments...>' }
if (-not $WorkingDirectory) { $WorkingDirectory = (Get-Location).Path }

$me = "$env:USERDOMAIN\$env:USERNAME"
$console = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $console) { Stop-Here "nobody is logged on to the desktop of $env:COMPUTERNAME; log on as $me (or set up automatic logon) so a window can open" }
if ($console -ne $me) { Stop-Here "the desktop of $env:COMPUTERNAME belongs to $console, not $me; log on as $me there" }

$name = 'alba-desktop-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$dir = Join-Path $env:TEMP $name
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir 'out.log'; $exitFile = Join-Path $dir 'exit.txt'
# The command travels as JSON, so no argument is re-quoted on its way through the task.
$spec = @{ cwd = $WorkingDirectory; program = $Command[0]; args = @($Command | Select-Object -Skip 1); log = $log; exit = $exitFile } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $dir 'spec.json'), $spec, (New-Object System.Text.UTF8Encoding $false))
$inner = @'
$s = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'spec.json') | ConvertFrom-Json
$code = 1
try {
  Set-Location $s.cwd
  $ErrorActionPreference = 'Continue'
  & $s.program @($s.args) *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $s.log -Encoding utf8 -Append
  $code = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
} catch { "$_" | Out-File -FilePath $s.log -Encoding utf8 -Append }
[IO.File]::WriteAllText($s.exit, "$code")
'@
[IO.File]::WriteAllText((Join-Path $dir 'inner.ps1'), $inner, (New-Object System.Text.UTF8Encoding $false))

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $dir 'inner.ps1')`"" -WorkingDirectory $WorkingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes ($TimeoutMinutes + 5)) -MultipleInstances IgnoreNew
try {
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "[desktop-run] started in the desktop session of ${me}: $($Command -join ' ')"
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes); $shown = 0
  while (-not (Test-Path $exitFile)) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) { $lines = @(Get-Content -Encoding UTF8 $log); if ($lines.Count -gt $shown) { $lines[$shown..($lines.Count - 1)] | ForEach-Object { Write-Host $_ }; $shown = $lines.Count } }
    if ((Get-Date) -gt $deadline) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Stop-Here "the command did not end within $TimeoutMinutes minutes; it was stopped" 124 }
    $state = (Get-ScheduledTask -TaskName $name).State
    if ($state -eq 'Ready' -and -not (Test-Path $exitFile)) { Start-Sleep -Seconds 2; if (-not (Test-Path $exitFile)) { Stop-Here "the task ended without an exit code (last result $((Get-ScheduledTaskInfo -TaskName $name).LastTaskResult))" } }
  }
  if (Test-Path $log) { $lines = @(Get-Content -Encoding UTF8 $log); if ($lines.Count -gt $shown) { $lines[$shown..($lines.Count - 1)] | ForEach-Object { Write-Host $_ } } }
  $code = [int](Get-Content $exitFile)
  exit $code
} finally {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
