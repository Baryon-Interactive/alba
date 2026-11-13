<#
.SYNOPSIS
  Registers a Windows scheduled task that runs one real "alba tick" every few minutes.

.DESCRIPTION
  This script is only an example for a person to run on their own machine. The tool never runs it and never installs a task by itself.
  It registers one task for the current user ("run only when the user is logged on", no password stored). Use -WhatIf to see what it would do,
  -Unregister to remove the task again.

  A tick exits with 0 (nothing to say), 1 (something could be done) or 2 (problems); those are normal results, not failures of the task.
  If you would rather watch the ticks in a window, "alba tick --every <minutes>" does the same loop in the foreground.

.EXAMPLE
  .\schedule-windows.ps1 -Project ./project/alba.yaml -Workers ./workers.yaml -Minutes 10 -WhatIf
  .\schedule-windows.ps1 -Project ./project/alba.yaml -Workers ./workers.yaml -Minutes 10
  .\schedule-windows.ps1 -Unregister
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Project,
  [string]$Workers,
  [int]$Minutes = 10,
  [int]$MaxDispatch = 1,
  [string]$TaskName = 'alba-tick',
  [string]$Node = 'node',
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This example requires Windows Task Scheduler.' }

if ($Unregister) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister the scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task $TaskName"
  }
  return
}

if (-not $Project) { throw 'Pass -Project <path to alba.yaml>.' }
if ($Minutes -lt 1) { throw '-Minutes must be at least 1.' }

$main = Join-Path (Join-Path $Repo 'bin') 'alba.mjs'
if (-not (Test-Path $main)) { throw "Cannot find $main; pass -Repo <folder of the Alba checkout>." }

$arguments = @('--disable-warning=ExperimentalWarning', "`"$main`"", '--project', "`"$Project`"")
if ($Workers) { $arguments += @('--workers', "`"$Workers`"") }
$arguments += @('tick', '--max-dispatch', $MaxDispatch)

$action = New-ScheduledTaskAction -Execute $Node -Argument ($arguments -join ' ') -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Write-Host "Task:    $TaskName"
Write-Host "Runs:    $Node $($arguments -join ' ')"
Write-Host "Every:   $Minutes minute(s), in $Repo"

if ($PSCmdlet.ShouldProcess($TaskName, 'Register the scheduled task')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Write-Host "Registered. Remove it with: .\schedule-windows.ps1 -Unregister"
}
