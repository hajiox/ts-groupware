param(
    [string]$SourceEnvFile = "C:\作業用\tsai-sales-db\.env.local"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SourceEnvFile)) {
    throw "Integration source environment file was not found: $SourceEnvFile"
}

$entry = Get-Content -LiteralPath $SourceEnvFile |
    Where-Object { $_ -match '^TSG_INTEGRATION_SECRET=' } |
    Select-Object -Last 1
if (-not $entry) {
    throw 'TSG_INTEGRATION_SECRET is missing from the integration source environment.'
}

$secret = ($entry -split '=', 2)[1].Trim()
if ($secret.Length -ge 2) {
    $quoted = ($secret.StartsWith('"') -and $secret.EndsWith('"')) -or
        ($secret.StartsWith("'") -and $secret.EndsWith("'"))
    if ($quoted) {
        $secret = $secret.Substring(1, $secret.Length - 2)
    }
}
$secret = $secret.Trim([char]0xFEFF)
if ([string]::IsNullOrWhiteSpace($secret)) {
    throw 'TSG_INTEGRATION_SECRET is empty in the integration source environment.'
}

$vercelCommand = Join-Path $env:APPDATA 'npm\vercel.cmd'
if (-not (Test-Path -LiteralPath $vercelCommand)) {
    throw "Vercel CLI was not found: $vercelCommand"
}
$processInfo = [Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = 'cmd.exe'
$processInfo.ArgumentList.Add('/d')
$processInfo.ArgumentList.Add('/s')
$processInfo.ArgumentList.Add('/c')
$processInfo.ArgumentList.Add("$vercelCommand env add TSG_INTEGRATION_SECRET production --force --sensitive --yes")
$processInfo.WorkingDirectory = $PSScriptRoot | Split-Path -Parent
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardInput = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true

$process = [Diagnostics.Process]::Start($processInfo)
$process.StandardInput.Write($secret)
$process.StandardInput.Close()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    $errorOutput = $process.StandardError.ReadToEnd()
    if ($errorOutput) {
        Write-Error $errorOutput
    }
    throw 'Failed to update TSG_INTEGRATION_SECRET in Vercel.'
}

Write-Output 'TSG production integration credentials updated without printing secret values.'
