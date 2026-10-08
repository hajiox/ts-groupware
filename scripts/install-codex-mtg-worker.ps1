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
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
while ($true) {
  & $nodePath (Join-Path $runtimeDir 'worker.mjs') --config (Join-Path $runtimeDir 'worker.config.json')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Start-Sleep -Seconds 15
}
'@
[System.IO.File]::WriteAllText($launcherPath, $launcher, (New-Object System.Text.UTF8Encoding($false)))
$taskName = 'TSG Codex MTG Worker'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments -WorkingDirectory $installPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'TSG Codex MTG専用。既存TSA workerとは別に実行し、統合モニタへ状態を書き込みます。' -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
Write-Output 'TSG専用workerを登録しました。秘密値は表示していません。既存TSA workerは変更していません。'
