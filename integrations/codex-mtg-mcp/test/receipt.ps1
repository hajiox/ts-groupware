# Run with Windows PowerShell 5.1. Uses only a synthetic token and temporary profile.
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('mtg-receipt-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$originalProfile = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $testRoot
$package = Split-Path -Parent $PSScriptRoot
$thumbprint = $null
try {
    & (Join-Path $package 'Request-Connection.ps1') -Label receipt-test -Share $testRoot | Out-Null
    $request = Get-Content (Join-Path $testRoot 'AizuDataMCP/requests/receipt-test.request.json') -Raw | ConvertFrom-Json
    $thumbprint = $request.certificateThumbprint
    $certificate = Get-Item ('Cert:/CurrentUser/My/' + $thumbprint)
    $fakeToken = 'tsg_mtg_' + ('x' * 43)
    $payload = @{version=1;requestId=$request.requestId;tokens=@{codexmtg=$fakeToken}} | ConvertTo-Json -Compress
    $cms = Protect-CmsMessage -To $certificate -Content $payload
    $cipherPath = Join-Path $testRoot 'test.cms'
    [IO.File]::WriteAllText($cipherPath,$cms,(New-Object Text.UTF8Encoding($false)))
    $digest = (Get-FileHash $cipherPath -Algorithm SHA256).Hash
    $receive = Join-Path $package 'Receive-CodexMtgKey.ps1'
    & $receive -Label receipt-test -EncryptedPath $cipherPath -ExpectedEncryptedSha256 $digest | Out-Null
    & $receive -Label receipt-test -EncryptedPath $cipherPath -ExpectedEncryptedSha256 $digest | Out-Null
    $tokenPath=Join-Path $testRoot 'AizuDataMCP/private/codex-mtg.token'
    if (([IO.File]::ReadAllText($tokenPath)).Trim() -cne $fakeToken) {throw 'Round trip mismatch'}
    $rejected=$false
    try { & $receive -Label receipt-test -EncryptedPath $cipherPath -ExpectedEncryptedSha256 ('0'*64) | Out-Null } catch {$rejected=$true}
    if (-not $rejected) {throw 'Wrong digest accepted'}
    [IO.File]::WriteAllText($tokenPath,('tsg_mtg_' + ('y'*43)),(New-Object Text.UTF8Encoding($false)))
    $rejected=$false
    try { & $receive -Label receipt-test -EncryptedPath $cipherPath -ExpectedEncryptedSha256 $digest | Out-Null } catch {$rejected=$true}
    if (-not $rejected) {throw 'Different existing key overwritten'}
    $dataToken = 'tsg_data_' + ('z' * 43)
    $payload = @{version=1;requestId=$request.requestId;tokens=@{tsg=$dataToken}} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($cipherPath,(Protect-CmsMessage -To $certificate -Content $payload),(New-Object Text.UTF8Encoding($false)))
    $digest = (Get-FileHash $cipherPath -Algorithm SHA256).Hash
    & (Join-Path $package 'Receive-DataKey.ps1') -System tsg -Label receipt-test -EncryptedPath $cipherPath -ExpectedEncryptedSha256 $digest | Out-Null
    if (([IO.File]::ReadAllText((Join-Path $testRoot 'AizuDataMCP/private/tsg.token'))).Trim() -cne $dataToken) {throw 'Data round trip mismatch'}
    Write-Output 'PASS: CMS round trip, repeat receipt, wrong digest rejection, no overwrite, single data key receipt'
} finally {
    $env:LOCALAPPDATA=$originalProfile
    if ($thumbprint -match '^[A-Fa-f0-9]{40}$') {Remove-Item -LiteralPath ('Cert:/CurrentUser/My/' + $thumbprint) -Force}
    # Preserve synthetic temporary files for diagnosis; never touch real profiles.
}
