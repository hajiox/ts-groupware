#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$EncryptedPath,
    [Parameter(Mandatory = $true)][ValidatePattern('\A[A-Fa-f0-9]{64}\z')][string]$ExpectedEncryptedSha256,
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

function Set-PrivateAcl([string]$Path, [Security.Principal.SecurityIdentifier]$UserSid, [bool]$Directory) {
    Assert-PlainLocalPath $Path
    if ($Directory) { [void][IO.Directory]::CreateDirectory($Path); $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($UserSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        if ($Directory) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                $sid, [Security.AccessControl.FileSystemRights]::FullControl,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        } else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow) }
        [void]$acl.AddAccessRule($rule)
    }
    if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) }
    else { [IO.File]::SetAccessControl($Path, $acl) }
    $actual = Get-Acl -LiteralPath $Path
    if (-not $actual.AreAccessRulesProtected) { throw 'The private ACL was not established.' }
    $allowed = @($UserSid.Value, 'S-1-5-18')
    foreach ($rule in $actual.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'Unexpected private ACL entries.' }
    }
}

function Get-Sha256([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-', '') }
    finally { $hash.Dispose() }
}

function Assert-Fields($Object, [string[]]$Expected) {
    if ($null -eq $Object -or $Object -isnot [pscustomobject]) { throw 'Invalid fixed payload object.' }
    $names = @($Object.PSObject.Properties.Name)
    if ($names.Count -ne $Expected.Count) { throw 'Invalid fixed payload fields.' }
    foreach ($name in $names) { if ($Expected -cnotcontains $name) { throw 'Invalid fixed payload fields.' } }
}

function Assert-StoredToken([string]$Path, [string]$Expected, [Security.Principal.SecurityIdentifier]$UserSid, [Text.UTF8Encoding]$Encoding) {
    Set-PrivateAcl $Path $UserSid $false
    if ((Get-Item -LiteralPath $Path).Length -gt 1024) { throw 'An existing dedicated token is invalid.' }
    $storedBytes = [IO.File]::ReadAllBytes($Path)
    if ($storedBytes.Length -ge 3 -and $storedBytes[0] -eq 239 -and $storedBytes[1] -eq 187 -and $storedBytes[2] -eq 191) { throw 'A token file must not contain a UTF-8 BOM.' }
    $stored = $Encoding.GetString($storedBytes)
    if ($stored.EndsWith("`r`n", [StringComparison]::Ordinal)) { $stored = $stored.Substring(0, $stored.Length - 2) }
    elseif ($stored.EndsWith("`n", [StringComparison]::Ordinal)) { $stored = $stored.Substring(0, $stored.Length - 1) }
    if ($stored -cne $Expected) { throw 'An existing dedicated token differs or has invalid whitespace; it will not be overwritten.' }
}

if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) { throw 'Run this script on the requesting Windows PC as the same user.' }
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 (powershell.exe), not pwsh, for this Windows certificate receipt script.' }
$sourceFile = [IO.Path]::GetFullPath($EncryptedPath)
$profileDirectory = Join-Path $env:LOCALAPPDATA 'AizuDataMCP\requests'
$stateFile = Join-Path $profileDirectory ($Label + '.request.json')
$privateDirectory = Join-Path $env:LOCALAPPDATA 'AizuDataMCP\private'
if (-not $PSCmdlet.ShouldProcess($privateDirectory, 'Verify the pinned encrypted package, decrypt with the local recipient certificate, and store the dedicated CodexMTG token without overwriting different values')) { return }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$mutex = New-Object Threading.Mutex($false, ('Local\AizuDataMCPReceive_' + $identity.User.Value))
$locked = $false
$certificate = $null
$plaintext = $null
$payload = $null
$stage = 'local request validation'
try {
    if (-not (Get-Module Microsoft.PowerShell.Security)) { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop }
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another receive operation is active.' }
    Assert-PlainLocalPath $stateFile
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    if (-not [IO.File]::Exists($stateFile) -or (Get-Item -LiteralPath $stateFile).Length -gt 16384) { throw 'The local request is missing or invalid.' }
    $request = [IO.File]::ReadAllText($stateFile, $utf8) | ConvertFrom-Json
    Assert-Fields $request @('version', 'requestId', 'label', 'computerName', 'user', 'certificateThumbprint', 'certificateSha256', 'createdAt', 'expiresAt')
    $requestGuid = [Guid]::Empty
    if ($request.version -ne 1 -or $request.label -cne $Label -or $request.computerName -cne $env:COMPUTERNAME -or $request.user -cne $identity.Name -or
        -not [Guid]::TryParseExact([string]$request.requestId, 'D', [ref]$requestGuid) -or
        [string]$request.certificateThumbprint -notmatch '\A[A-Fa-f0-9]{40}\z' -or
        [string]$request.certificateSha256 -notmatch '\A[A-Fa-f0-9]{64}\z') { throw 'The local request identity is invalid.' }
    $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $request.certificateThumbprint)
    $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    if (-not $certificate.HasPrivateKey -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date) -or
        (Get-Sha256 $certificate.RawData) -cne $request.certificateSha256 -or
        $eku.Count -ne 1 -or @($eku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.4.1.311.80.1' }).Count -ne 1) { throw 'The local recipient certificate is invalid.' }
    $key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    try {
        if ($key -isnot [Security.Cryptography.RSACng] -or $key.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) { throw 'The recipient key must remain non-exportable.' }
    } finally { if ($key) { $key.Dispose() } }

    $stage = 'encrypted package verification'
    if (-not [IO.File]::Exists($sourceFile) -or (Get-Item -LiteralPath $sourceFile).Length -gt 65536) { throw 'The encrypted package is missing or too large.' }
    $cipherBytes = [IO.File]::ReadAllBytes($sourceFile)
    if ((Get-Sha256 $cipherBytes) -ine $ExpectedEncryptedSha256) { throw 'The encrypted package fingerprint does not match the trusted issuer message.' }
    $ciphertext = $utf8.GetString($cipherBytes).TrimStart([char]0xFEFF).Trim()
    if ($ciphertext -notmatch '\A-----BEGIN CMS-----[\s\S]+-----END CMS-----\z') { throw 'Only one complete CMS encrypted package is accepted.' }
    $stage = 'CMS decryption and fixed payload validation'
    # Unprotect-CmsMessage can search other local certificates even when -To is supplied.
    # Pin the standard CMS RecipientInfo before invoking the Windows CMS cmdlet.
    Add-Type -AssemblyName System.Security
    $envelope = New-Object Security.Cryptography.Pkcs.EnvelopedCms
    $base64 = $ciphertext.Substring('-----BEGIN CMS-----'.Length)
    $base64 = $base64.Substring(0, $base64.Length - '-----END CMS-----'.Length) -replace '\s', ''
    $envelope.Decode([Convert]::FromBase64String($base64))
    if ($envelope.RecipientInfos.Count -ne 1) { throw 'The CMS package must have exactly one recipient.' }
    $recipient = $envelope.RecipientInfos[0].RecipientIdentifier
    if ($recipient.Type -ne [Security.Cryptography.Pkcs.SubjectIdentifierType]::IssuerAndSerialNumber -or
        $recipient.Value.IssuerName -cne $certificate.Issuer -or $recipient.Value.SerialNumber -ine $certificate.SerialNumber) { throw 'The CMS recipient does not match the pinned local certificate.' }
    $matchingCertificates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Issuer -ceq $certificate.Issuer -and $_.SerialNumber -ieq $certificate.SerialNumber })
    if ($matchingCertificates.Count -ne 1 -or $matchingCertificates[0].Thumbprint -ine $certificate.Thumbprint) { throw 'The CMS recipient certificate identity is ambiguous.' }
    $plaintext = Unprotect-CmsMessage -Content $ciphertext -To $certificate -ErrorAction Stop
    $payload = $plaintext | ConvertFrom-Json -ErrorAction Stop
    Assert-Fields $payload @('version', 'requestId', 'tokens')
    Assert-Fields $payload.tokens @('codexmtg')
    if (($payload.version -isnot [int] -and $payload.version -isnot [long]) -or $payload.version -ne 1 -or
        $payload.requestId -isnot [string] -or $payload.requestId -cne $requestGuid.ToString('D')) { throw 'The decrypted payload is not for this request.' }
    $tokenPatterns = @{ codexmtg = '\Atsg_mtg_[A-Za-z0-9_-]{43}\z' }
    foreach ($name in @('codexmtg')) {
        $value = $payload.tokens.$name
        if ($value -isnot [string] -or $value -cnotmatch $tokenPatterns[$name]) { throw 'A dedicated token has an invalid schema.' }
    }

    $stage = 'private storage preparation'
    Set-PrivateAcl $privateDirectory $identity.User $true
    $files = [ordered]@{ codexmtg = Join-Path $privateDirectory 'codex-mtg.token' }
    foreach ($name in $files.Keys) {
        Assert-PlainLocalPath $files[$name]
        if ([IO.File]::Exists($files[$name])) {
            Assert-StoredToken $files[$name] $payload.tokens.$name $identity.User $utf8
        }
    }
    $stage = 'private token storage'
    $created = 0
    foreach ($name in $files.Keys) {
        if ([IO.File]::Exists($files[$name])) {
            Assert-StoredToken $files[$name] $payload.tokens.$name $identity.User $utf8
            continue
        }
        $bytes = $utf8.GetBytes($payload.tokens.$name + "`n")
        $stream = New-Object IO.FileStream($files[$name], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
        finally { $stream.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
        $created += 1
    }
    [pscustomobject]@{ Status = 'ready'; RequestId = $requestGuid.ToString('D'); CreatedFiles = $created; TokenFiles = $files; CredentialsPrinted = $false } | ConvertTo-Json -Depth 3
} catch {
    throw (New-Object InvalidOperationException('Connection receipt failed at ' + $stage + '. Secret values were not printed; different existing tokens were not overwritten.'))
} finally {
    $plaintext = $null; $payload = $null
    if ($certificate) { $certificate.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose(); $identity.Dispose()
}
