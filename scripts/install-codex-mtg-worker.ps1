param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TSG Codex MTG'),
  [switch]$NoStart,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workerSource = Join-Path $sourceRoot 'scripts\codex-mtg-worker.mjs'
$skillSource = Join-Path $sourceRoot 'docs\skills\tsg-codex-mtg\SKILL.md'
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$expectedPath = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TSG Codex MTG'))
if ($installPath -ne $expectedPath) { throw '専用のLOCALAPPDATAフォルダ以外にはインストールしません。' }
$configPath = Join-Path $installPath 'worker.config.json'
$lockPath = Join-Path $installPath 'worker.lock'
if (Test-Path -LiteralPath $lockPath) {
  $workerPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $lockPath -Raw), [ref]$workerPid)) { throw 'worker lockを確認してください。既存workerは停止しません。' }
  if (Get-Process -Id $workerPid -ErrorAction SilentlyContinue) { throw 'workerが稼働中です。自動停止や上書きは行いません。' }
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw '先に専用worker.config.jsonを安全に配置してください。キーを引数へ渡さないでください。' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not [System.IO.Path]::IsPathRooted($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node executable path is invalid.' }
& $nodePath --check $workerSource
if ($LASTEXITCODE -ne 0) { throw 'workerの構文検証に失敗しました。' }
if ($CheckOnly) { Write-Output '構文と配置先を確認しました。登録・起動・API呼出は行っていません。'; return }

New-Item -ItemType Directory -Path (Join-Path $installPath 'skill') -Force | Out-Null
# Keep the dedicated token and lease journal readable only by this user and SYSTEM.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
function Protect-PrivatePath([string]$Path, [bool]$Directory) {
  $privateAcl = Get-Acl -LiteralPath $Path
  $privateSids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($Directory) { $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  $rules = @($privateAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $matching = @($rules | Where-Object {
    $_.IdentityReference.Value -in $privateSids.Value -and
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
    $_.InheritanceFlags -eq $inheritance -and
    $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and -not $_.IsInherited
  })
  if ($privateAcl.AreAccessRulesProtected -and $rules.Count -eq 2 -and $matching.Count -eq 2 -and @($matching.IdentityReference.Value | Select-Object -Unique).Count -eq 2) { return }
  # Modify only the existing DACL; do not replace owner, group, or audit security.
  $privateAcl.SetAccessRuleProtection($true, $false)
  foreach ($oldRule in @($privateAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { $privateAcl.RemoveAccessRuleSpecific($oldRule) }
  foreach ($privateSid in $privateSids) {
    $privateRule = New-Object System.Security.AccessControl.FileSystemAccessRule($privateSid, 'FullControl', $inheritance, 'None', 'Allow')
    $privateAcl.AddAccessRule($privateRule)
  }
  Set-Acl -LiteralPath $Path -AclObject $privateAcl
}
Protect-PrivatePath $installPath $true
Copy-Item -LiteralPath $workerSource -Destination (Join-Path $installPath 'worker.mjs')
Copy-Item -LiteralPath $skillSource -Destination (Join-Path $installPath 'skill\SKILL.md')
# Apply inherited access restrictions to an already-created configuration too.
Protect-PrivatePath $configPath $false
& $nodePath (Join-Path $installPath 'worker.mjs') --config $configPath --check
if ($LASTEXITCODE -ne 0) { throw '設定またはCLI検証に失敗しました。設定の内容は表示しません。' }

$launcherPath = Join-Path $installPath 'start-worker.ps1'
$launcher = @'
$ErrorActionPreference = 'Stop'
$runtimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = '__TSG_VERIFIED_NODE_PATH__'
$startupPath = Join-Path $runtimeDir 'startup-status.json'
function Write-StartupStatus([string]$Step, $NodeExitCode = $null, [string]$CatchType = $null) {
  $status = @{ step = $Step; nodeExitCode = $NodeExitCode; catchType = $CatchType } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($startupPath, $status, (New-Object System.Text.UTF8Encoding($false)))
}
try {
  Write-StartupStatus 'launcher_start'
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw (New-Object System.IO.FileNotFoundException) }
  Write-StartupStatus 'config_check'
  $ErrorActionPreference = 'Continue'
  & $nodePath (Join-Path $runtimeDir 'worker.mjs') --config (Join-Path $runtimeDir 'worker.config.json') --check 1>$null 2>$null
  $nodeExitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($nodeExitCode -ne 0) { Write-StartupStatus 'config_check_failed' $nodeExitCode; exit $nodeExitCode }
  while ($true) {
    Write-StartupStatus 'worker_start' 0
    $ErrorActionPreference = 'Continue'
    & $nodePath (Join-Path $runtimeDir 'worker.mjs') --config (Join-Path $runtimeDir 'worker.config.json') 1>$null 2>$null
    $nodeExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Write-StartupStatus 'worker_exit' $nodeExitCode
    if ($nodeExitCode -ne 0) { exit $nodeExitCode }
    Start-Sleep -Seconds 15
  }
} catch {
  try { Write-StartupStatus 'launcher_failed' $null $_.Exception.GetType().Name } catch {}
  exit 1
}
'@
$launcher = $launcher.Replace('__TSG_VERIFIED_NODE_PATH__', $nodePath.Replace("'", "''"))
[System.IO.File]::WriteAllText($launcherPath, $launcher, (New-Object System.Text.UTF8Encoding($false)))
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw 'Windows PowerShell executable is unavailable.' }
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
$startupDir = [System.Environment]::GetFolderPath('Startup')
if (-not $startupDir -or -not [System.IO.Path]::IsPathRooted($startupDir)) { throw 'Current-user Startup directory is unavailable.' }
$legacyTask = Get-ScheduledTask -TaskName 'TSG Codex MTG Worker' -ErrorAction SilentlyContinue
if ($legacyTask -and $legacyTask.State -notin @('Ready', 'Disabled')) { throw 'TSG worker task is not stopped; it will not be stopped or removed automatically.' }
New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
$shortcutPath = Join-Path $startupDir 'TSG Codex MTG.lnk'
$shortcutShell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powerShellPath
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $env:SystemRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'TSG Codex MTG worker; unified monitor state only.'
  $shortcut.Save()
} finally { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutShell) | Out-Null }
if ($legacyTask) { Unregister-ScheduledTask -TaskName 'TSG Codex MTG Worker' -Confirm:$false -ErrorAction Stop }
if (-not $NoStart) { Start-Process -FilePath $powerShellPath -ArgumentList $arguments -WindowStyle Hidden | Out-Null }
Write-Output 'TSG専用workerのStartup登録を完了しました。秘密値は表示していません。既存TSA workerは変更していません。'
