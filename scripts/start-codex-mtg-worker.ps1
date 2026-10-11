param([switch]$OperatorRestart)
$ErrorActionPreference = 'Stop'
$runtimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = '__TSG_VERIFIED_NODE_PATH__'
$workerPath = Join-Path $runtimeDir 'worker.mjs'
$configPath = Join-Path $runtimeDir 'worker.config.json'
$startupPath = Join-Path $runtimeDir 'startup-status.json'
$restartCount = 0
$launcherLock = $null
function Write-StartupStatus([string]$Step, $NodeExitCode = $null, [string]$CatchType = $null) {
  $status = @{ step = $Step; nodeExitCode = $NodeExitCode; catchType = $CatchType; launcherPid = $PID; restartCount = $restartCount; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($startupPath, $status, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-StopLatch([string]$Reason) {
  $latch = @{ version = 1; mode = 'blocked'; reason = $Reason; workerPid = $PID; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $runtimeDir 'restart-state.json'), $latch, (New-Object System.Text.UTF8Encoding($false)))
}
function Invoke-LocalWorker([string[]]$WorkerArguments) {
  $ErrorActionPreference = 'Continue'
  & $nodePath $workerPath --config $configPath @WorkerArguments 1>$null 2>$null
  return $LASTEXITCODE
}
function Get-RestartCheck {
  $ErrorActionPreference = 'Continue'
  $resultText = & $nodePath $workerPath --config $configPath --restart-check 2>$null
  $resultCode = $LASTEXITCODE
  try {
    $result = $resultText | ConvertFrom-Json -ErrorAction Stop
    if ($result.exitCode -ne $resultCode -or $result.decision -notin @('start', 'already_running', 'blocked')) { throw 'Invalid check result' }
    return $result
  } catch { return @{ decision = 'blocked'; reason = 'state_unreadable'; exitCode = 20 } }
}
try {
  # Concurrent Startup/task/manual invocations never create a second launcher.
  try { $launcherLock = [System.IO.File]::Open((Join-Path $runtimeDir 'launcher.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
  catch [System.IO.IOException] { exit 0 }
  Write-StartupStatus 'launcher_start'
  # Respect fixed stop metadata even when the private config/Node is broken.
  $latchPath = Join-Path $runtimeDir 'restart-state.json'
  if (-not $OperatorRestart -and (Test-Path -LiteralPath $latchPath)) {
    try {
      if ((Get-Item -LiteralPath $latchPath).Length -gt 1024) { throw 'Invalid restart latch' }
      $latch = [System.IO.File]::ReadAllText($latchPath) | ConvertFrom-Json -ErrorAction Stop
      if ($latch.mode -in @('blocked', 'stopped')) { Write-StartupStatus 'operator_review_required' 20; exit 0 }
    } catch { Write-StartupStatus 'operator_review_required' 20; exit 0 }
  }
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw (New-Object System.IO.FileNotFoundException) }
  while ($true) {
    Write-StartupStatus 'config_check'
    $checkCode = Invoke-LocalWorker @('--check')
    if ($checkCode -ne 0) { Write-StopLatch 'startup_failed'; Write-StartupStatus 'config_check_failed' $checkCode; exit $checkCode }
    $check = Get-RestartCheck
    if ($check.decision -eq 'already_running') { Write-StartupStatus $check.reason 0; exit 0 }
    if ($check.decision -ne 'start' -and -not $OperatorRestart) { Write-StartupStatus 'operator_review_required' $check.exitCode; exit 0 }
    $workerArguments = @()
    if ($OperatorRestart) { $workerArguments += '--operator-restart'; $OperatorRestart = $false }
    Write-StartupStatus 'worker_start' 0
    $startedAt = [DateTime]::UtcNow
    $nodeExitCode = Invoke-LocalWorker $workerArguments
    Write-StartupStatus 'worker_exit' $nodeExitCode
    if ($nodeExitCode -eq 0) { exit 0 }
    # Only safe idle crashes are recoverable. Journals and durable stop latches
    # are rechecked before every retry and by every scheduled invocation.
    $check = Get-RestartCheck
    if ($check.decision -eq 'already_running') { Write-StartupStatus $check.reason 0; exit 0 }
    if ($check.decision -ne 'start') { Write-StartupStatus 'operator_review_required' $check.exitCode; exit 0 }
    if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 300) { $restartCount = 0 }
    $restartCount++
    if ($restartCount -ge 5) {
      Write-StopLatch 'crash_limit'
      Write-StartupStatus 'crash_limit' $nodeExitCode
      exit 0
    }
    Write-StartupStatus 'restart_pending' $nodeExitCode
    Start-Sleep -Seconds 15
  }
} catch {
  try { Write-StopLatch 'startup_failed' } catch {}
  try { Write-StartupStatus 'launcher_failed' $null $_.Exception.GetType().Name } catch {}
  exit 1
} finally { if ($launcherLock) { $launcherLock.Dispose() } }
