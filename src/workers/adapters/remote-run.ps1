# Runs one alba order on this machine for a worker on another machine. Copied into <workspace>/runs/<id>/ with spec.json and
# overlay/ next to it, and started over SSH by remote-run.mjs. Windows PowerShell 5.1.
#   -Mode prepare  make sure the bare repository exists (before the branch is pushed to it)
#   -Mode run      check the branch out in this machine's worktree, add the overlay, run the worker, collect what it left
#   -Mode watch    (started by run) end the worker when the SSH session that started it is gone
param([string]$Mode = 'run', [int]$Port = 0, [int]$Session = 0, [string]$SessionStart = '', [int]$Root = 0, [string]$RootStart = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

# Windows OpenSSH does not end a session's processes when the client goes away (alba stopped the run, the network dropped).
# The watcher checks every 10 s that the sshd process of this session still exists; when it is gone, it ends the worker's
# process tree (only processes started after their parent, so a reused pid is never followed) and then the run itself.
if ($Mode -eq 'watch') {
  Start-Transcript -Path (Join-Path $PSScriptRoot 'watch.log') -Append | Out-Null
  while ($true) {
    Start-Sleep -Seconds 10
    $all = @(Get-CimInstance Win32_Process)
    # (PowerShell names ignore case: $rootProcess, not $root, which would be the [int] parameter $Root)
    $rootProcess = $all | Where-Object { $_.ProcessId -eq $Root -and $_.CreationDate.ToString('o') -eq $RootStart }
    if (-not $rootProcess) { exit 0 }
    $sessionProcess = $all | Where-Object { $_.ProcessId -eq $Session -and $_.CreationDate.ToString('o') -eq $SessionStart }
    if ($sessionProcess) { continue }
    $order = New-Object System.Collections.Generic.List[int]
    function Visit($parent) {
      foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate -and $_.ProcessId -ne $PID }) { Visit $c; $order.Add([int]$c.ProcessId) }
    }
    Visit $rootProcess
    $order.Add($Root)
    foreach ($id in $order) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    exit 0
  }
}

$spec = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'spec.json') | ConvertFrom-Json
function Say([string]$text) { [Console]::Error.WriteLine("[remote] $text") }
function Invoke-Git {  # not "Git": PowerShell names are case-insensitive, so it would call itself
  $ErrorActionPreference = 'Continue'   # native stderr under Stop would throw in Windows PowerShell 5.1
  $out = & git @args 2>&1
  if ($LASTEXITCODE) { throw "git $($args -join ' ') failed ($LASTEXITCODE): $($out -join ' ')" }
  $out
}

if ($Mode -eq 'prepare') {
  if (-not (Test-Path (Join-Path $spec.repo 'HEAD'))) {
    Say "creating the bare repository $($spec.repo)"
    Invoke-Git init -q --bare $spec.repo | Out-Null
  }
  # The Git LFS objects the branch needs (listed by alba) that this bare repository lacks: alba copies them next.
  $wanted = Join-Path $PSScriptRoot 'lfs-oids.txt'
  if (Test-Path $wanted) {
    $objects = Join-Path $spec.repo 'lfs/objects'
    New-Item -ItemType Directory -Force -Path $objects | Out-Null
    foreach ($oid in Get-Content -Encoding UTF8 $wanted) {
      $oid = $oid.Trim()
      if ($oid -match '^[0-9a-f]{64}$' -and -not (Test-Path -LiteralPath (Join-Path $objects "$($oid.Substring(0, 2))/$($oid.Substring(2, 2))/$oid"))) { "lfs-missing $oid" }
    }
  }
  exit 0
}

# A dispatch that cannot give the worker a usable checkout stops here, before the worker starts, with a line alba reports.
function Stop-Dispatch([string]$text) { [Console]::Error.WriteLine("[remote] dispatch failed: $text"); exit 3 }

$repo = $spec.repo; $wt = $spec.worktree; $branch = $spec.branch; $incoming = "refs/alba/incoming/$branch"
# The same ignore list as the order's own repository, plus the folder that holds this run's order and prompt.
$info = Join-Path $repo 'info'
New-Item -ItemType Directory -Force -Path $info | Out-Null
$exclude = (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'exclude.txt')) + "`n.alba/order/`n"
[IO.File]::WriteAllText((Join-Path $info 'exclude'), $exclude, (New-Object System.Text.UTF8Encoding $false))
$env:GIT_LFS_SKIP_SMUDGE = '1'
if (-not (Test-Path (Join-Path $wt '.git'))) {
  Invoke-Git --git-dir $repo worktree prune | Out-Null
  Say "creating the worktree $wt"
  Invoke-Git --git-dir $repo worktree add -q -f -B $branch $wt $incoming | Out-Null
} else {
  if ((Invoke-Git -C $wt status --porcelain)) { throw 'Remote worktree has unsynchronized changes; preserve them before dispatching again.' }
  $old = (Invoke-Git -C $wt rev-parse HEAD) | Select-Object -First 1
  $isAncestor = & { $ErrorActionPreference = 'Continue'; & git -C $wt merge-base --is-ancestor $old $incoming 2>&1 | Out-Null; $LASTEXITCODE -eq 0 }
  if (-not $isAncestor) {
    $keep = "refs/alba/kept/$branch-" + (Get-Date -Format 'yyyyMMddHHmmss')
    Say "this worktree had commits the branch does not have; kept them as $keep"
    Invoke-Git -C $wt update-ref $keep $old | Out-Null
  }
  Invoke-Git -C $wt checkout -q -f -B $branch $incoming | Out-Null
}
Remove-Item Env:\GIT_LFS_SKIP_SMUDGE
& { $ErrorActionPreference = 'Continue'; & git -C $wt lfs checkout 2>&1 | Out-Null }
# A file left as an LFS pointer looks like a corrupt asset to the worker (UI0 deleted nine .uasset files it took for broken ones).
if ((Test-Path (Join-Path $PSScriptRoot 'lfs-oids.txt')) -and (Get-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'lfs-oids.txt') | Where-Object { $_.Trim() })) {
  $listed = & { $ErrorActionPreference = 'Continue'; & git -C $wt lfs ls-files 2>&1 }
  if ($LASTEXITCODE) { Stop-Dispatch "the branch has Git LFS files but 'git lfs ls-files' failed on this machine (is Git LFS installed?): $(($listed | Select-Object -Last 2) -join ' ')" }
  $pointers = @($listed | ForEach-Object { "$_" } | Where-Object { $_ -match '^[0-9a-f]+ - ' } | ForEach-Object { ($_ -split ' - ', 2)[1] })
  if ($pointers.Count) { Stop-Dispatch "$($pointers.Count) Git LFS file(s) are still pointer files after checkout, their objects are missing on this machine: $(($pointers | Select-Object -First 10) -join ', ')$(if ($pointers.Count -gt 10) { ', ...' })" }
}
if (-not (& git -C $wt config user.email)) {
  if ($spec.identity.email) { Invoke-Git -C $wt config user.email $spec.identity.email | Out-Null }
  if ($spec.identity.name) { Invoke-Git -C $wt config user.name $spec.identity.name | Out-Null }
}
$overlay = Join-Path $PSScriptRoot 'overlay'
if (Test-Path $overlay) { Copy-Item -Path (Join-Path $overlay '*') -Destination $wt -Recurse -Force }
$result = Join-Path $PSScriptRoot 'result'
if (Test-Path -LiteralPath $result) { throw 'Remote results already exist; preserve them and use a new run id.' }
New-Item -ItemType Directory -Force -Path $result | Out-Null

# The nearest sshd.exe above this script is the session; a watcher ends the worker when it is gone.
$procs = @(Get-CimInstance Win32_Process)
$cur = $procs | Where-Object ProcessId -eq $PID
$selfStart = $cur.CreationDate.ToString('o')
while ($cur -and $cur.Name -ne 'sshd.exe') { $parent = $procs | Where-Object ProcessId -eq $cur.ParentProcessId; $cur = if ($parent -and $parent.CreationDate -le $cur.CreationDate) { $parent } else { $null } }
if ($cur) {
  $watch = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode watch -Session $($cur.ProcessId) -SessionStart $($cur.CreationDate.ToString('o')) -Root $PID -RootStart $selfStart"
  Start-Process -FilePath powershell.exe -ArgumentList $watch -WindowStyle Hidden | Out-Null
  Say "watching SSH session $($cur.ProcessId)"
} else { Say 'no SSH session above this run; it will not be stopped when the connection goes away' }

# The worker: its environment, arguments with the tunnel port filled in, started from the worktree. Its input is empty (an
# engine that reads piped input would otherwise wait on the SSH channel).
Set-Location $wt
# A program that needs a window or a GPU swap chain cannot run in this SSH session; the worker starts it through this helper (see its head).
$env:ALBA_DESKTOP_RUN = Join-Path $PSScriptRoot 'desktop-run.ps1'
Say "starting $($spec.program) in $wt"
$ErrorActionPreference = 'Continue'
@() | & node (Join-Path $PSScriptRoot 'worker.mjs') $Port
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Say "the worker ended with exit code $code"

# What the worker left without committing: changed and new files, new files under .alba/ (ignored there), and deletions.
$changed = @(& git -C $wt ls-files -m -o --exclude-standard) + @(& git -C $wt ls-files -o -i --exclude-standard -- .alba)
$files = $changed | Where-Object { $_ -and -not $_.StartsWith('.alba/order/') -and $_ -ne '.alba/inbox.md' -and (Test-Path -LiteralPath (Join-Path $wt $_) -PathType Leaf) } | Sort-Object -Unique
foreach ($f in $files) {
  $to = Join-Path (Join-Path $result 'files') $f
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Copy-Item -LiteralPath (Join-Path $wt $f) -Destination $to -Force
}
$deleted = @(& git -C $wt ls-files -d)
[IO.File]::WriteAllText((Join-Path $result 'deleted.txt'), ($deleted -join "`n"), (New-Object System.Text.UTF8Encoding $false))
$last = Join-Path $wt '.alba/order/last.txt'
if (Test-Path $last) { Copy-Item $last (Join-Path $result 'last.txt') -Force }
exit $code
