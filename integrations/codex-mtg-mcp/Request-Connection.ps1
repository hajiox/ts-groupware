#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateNotNullOrEmpty()][string]$Share = '\\tshdd\disk\OneDrive共有\【共有】【個人】佐藤正彦\TSA',
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\z')][string]$Label = 'CEO_S'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Assert-PlainLocalPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if ($cursor.StartsWith('\\')) { throw 'A local user profile is required.' }
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed in the local profile.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Set-PrivateDirectory([string]$Path, [Security.Principal.SecurityIdentifier]$UserSid) {
    Assert-PlainLocalPath $Path
    [void][IO.Directory]::CreateDirectory($Path)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($UserSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($Path, $acl)
}

function Get-CertificateFingerprint($Certificate) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Certificate.RawData)).Replace('-', '') }
    finally { $hash.Dispose() }
}

function Assert-RecipientCertificate($Certificate) {
    if (-not $Certificate.HasPrivateKey -or $Certificate.NotBefore -gt (Get-Date) -or $Certificate.NotAfter -le (Get-Date)) { throw 'The local recipient certificate is unavailable or expired.' }
    $eku = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    if ($eku.Count -ne 1 -or @($eku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.4.1.311.80.1' }).Count -ne 1) { throw 'A document encryption certificate is required.' }
    $key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    try {
        if ($key -isnot [Security.Cryptography.RSACng] -or $key.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) { throw 'A non-exportable Windows CNG recipient key is required.' }
    } finally { if ($key) { $key.Dispose() } }
}

function Write-IdenticalOrNew([string]$Path, [byte[]]$Bytes) {
    if ([IO.File]::Exists($Path)) {
        $existing = [IO.File]::ReadAllBytes($Path)
        if ([Convert]::ToBase64String($existing) -cne [Convert]::ToBase64String($Bytes)) { throw 'An existing request artifact differs; it will not be overwritten.' }
        return
    }
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush() }
    finally { $stream.Dispose() }
}

if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) { throw 'Run this script on the receiving Windows PC as its intended user.' }
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 (powershell.exe), not pwsh, for this Windows certificate enrollment script.' }
$shareRoot = [IO.Path]::GetFullPath($Share)
$profileDirectory = Join-Path $env:LOCALAPPDATA 'AizuDataMCP\requests'
$stateFile = Join-Path $profileDirectory ($Label + '.request.json')
if (-not $PSCmdlet.ShouldProcess($shareRoot, 'Create or reuse a local non-exportable recipient certificate; publish only its public certificate and request metadata')) { return }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$mutex = New-Object Threading.Mutex($false, ('Local\AizuDataMCPRequest_' + $identity.User.Value + '_' + $Label))
$locked = $false
$certificate = $null
$stage = 'local request validation'
try {
    if (-not (Get-Module Microsoft.PowerShell.Security)) { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop }
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another request operation is active.' }
    if (-not [IO.Directory]::Exists($shareRoot)) { throw 'The specified share directory is unavailable.' }
    Set-PrivateDirectory $profileDirectory $identity.User
    $reused = [IO.File]::Exists($stateFile)
    $utf8 = New-Object Text.UTF8Encoding($false)
    if ($reused) {
        Assert-PlainLocalPath $stateFile
        $request = [IO.File]::ReadAllText($stateFile, $utf8) | ConvertFrom-Json
        $requestGuid = [Guid]::Empty
        if ($request.version -ne 1 -or $request.label -cne $Label -or $request.computerName -cne $env:COMPUTERNAME -or $request.user -cne $identity.Name -or
            -not [Guid]::TryParseExact([string]$request.requestId, 'D', [ref]$requestGuid) -or
            [string]$request.certificateThumbprint -notmatch '\A[A-Fa-f0-9]{40}\z' -or
            [string]$request.certificateSha256 -notmatch '\A[A-Fa-f0-9]{64}\z') { throw 'The existing local request is invalid; preserve it for inspection.' }
        $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $request.certificateThumbprint)
        Assert-RecipientCertificate $certificate
        if ((Get-CertificateFingerprint $certificate) -cne $request.certificateSha256) { throw 'The local recipient certificate does not match the request.' }
        $requestText = [IO.File]::ReadAllText($stateFile, $utf8)
    } else {
        $stage = 'recipient certificate creation'
        $requestGuid = [Guid]::NewGuid()
        $certificate = New-SelfSignedCertificate -Type DocumentEncryptionCert -Subject ('CN=AizuDataMCP-' + $requestGuid.ToString('D')) `
            -FriendlyName ('AizuDataMCP ' + $Label + ' ' + $requestGuid.ToString('D')) -CertStoreLocation 'Cert:\CurrentUser\My' `
            -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
            -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(90)
        Assert-RecipientCertificate $certificate
        $request = [ordered]@{
            version = 1; requestId = $requestGuid.ToString('D'); label = $Label
            computerName = $env:COMPUTERNAME; user = $identity.Name
            certificateThumbprint = $certificate.Thumbprint; certificateSha256 = Get-CertificateFingerprint $certificate
            createdAt = [DateTime]::UtcNow.ToString('o'); expiresAt = $certificate.NotAfter.ToUniversalTime().ToString('o')
        }
        $requestText = $request | ConvertTo-Json -Depth 3
        Write-IdenticalOrNew $stateFile ($utf8.GetBytes($requestText))
    }
    $stage = 'public request publication'
    $requestDirectory = Join-Path (Join-Path $shareRoot '接続申請') $requestGuid.ToString('D')
    [void][IO.Directory]::CreateDirectory($requestDirectory)
    Write-IdenticalOrNew (Join-Path $requestDirectory 'recipient.cer') $certificate.RawData
    Write-IdenticalOrNew (Join-Path $requestDirectory 'request.json') ($utf8.GetBytes($requestText))
    [pscustomobject]@{
        RequestId = $requestGuid.ToString('D'); Label = $Label; ComputerName = $env:COMPUTERNAME; User = $identity.Name
        CertificateThumbprint = $certificate.Thumbprint; CertificateSha256 = Get-CertificateFingerprint $certificate
        PublicRequestDirectory = $requestDirectory; ReusedRequest = $reused; AutomaticallyApproved = $false
    } | ConvertTo-Json -Depth 3
} catch {
    throw (New-Object InvalidOperationException('Connection request failed at ' + $stage + '. Existing artifacts were not overwritten.'))
} finally {
    if ($certificate) { $certificate.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose(); $identity.Dispose()
}
