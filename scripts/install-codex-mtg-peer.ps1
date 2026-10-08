param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -eq 'TSA') { throw 'TSA uses the existing owner worker; this installer is for peer PCs only.' }
$source = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:LOCALAPPDATA 'TSG Codex MTG Peer'
$token = Join-Path $env:LOCALAPPDATA 'AizuDataMCP\private\codex-mtg.token'
if (-not (Test-Path -LiteralPath $token -PathType Leaf)) { throw 'Receive the PC-specific CodexMTG key first. Do not paste a key into this command.' }
$lock = Join-Path $root 'peer.lock'
if (Test-Path -LiteralPath $lock) {
  $peerPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $lock -Raw), [ref]$peerPid)) { throw 'Invalid peer lock. Inspect before updating.' }
  if (Get-Process -Id $peerPid -ErrorAction SilentlyContinue) { throw 'Peer listener is running. It will not be stopped or overwritten.' }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $root -Force | Out-Null
$acl = Get-Acl -LiteralPath $root
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $root -AclObject $acl
New-Item -ItemType Directory -Path (Join-Path $root 'skill') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'scripts\codex-mtg-peer.mjs') -Destination $root
Copy-Item -LiteralPath (Join-Path $source 'scripts\codex-mtg-worker.mjs') -Destination $root
Copy-Item -LiteralPath (Join-Path $source 'docs\skills\tsg-codex-mtg-peer\SKILL.md') -Destination (Join-Path $root 'skill\SKILL.md')
& $node (Join-Path $root 'codex-mtg-peer.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'CLI/config validation failed. Startup not registered.' }
& $node (Join-Path $root 'codex-mtg-peer.mjs') --probe
if ($LASTEXITCODE -ne 0) { throw 'Registered machine identity validation failed. Startup not registered.' }
$launcher = Join-Path $root 'start-peer.ps1'
$body = @'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& '__NODE__' (Join-Path $root 'codex-mtg-peer.mjs') 1>$null 2>$null
exit $LASTEXITCODE
'@
[IO.File]::WriteAllText($launcher,$body.Replace('__NODE__',$node.Replace("'","''")),(New-Object Text.UTF8Encoding($false)))
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { throw 'Startup folder unavailable.' }
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut((Join-Path $startup 'TSG Codex MTG Peer.lnk'))
  $shortcut.TargetPath = $powershell; $shortcut.Arguments = $arguments; $shortcut.WorkingDirectory = $env:SystemRoot
  $shortcut.WindowStyle = 7; $shortcut.Description = 'CodexMTG automatic peer receiver'; $shortcut.Save()
} finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
if (-not $NoStart) { Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden | Out-Null }
Write-Output 'Peer listener installed. Verify its row in the unified Codex Bridge Monitor and report the actual result to CodexMTG.'
