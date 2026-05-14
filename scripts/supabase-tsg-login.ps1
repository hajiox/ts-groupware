param(
  [string]$ProjectRef = "zfhswguzqyagmhhlpksq",
  [string]$Token = "",
  [string]$DbPassword = ""
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
  $Token = Read-Host "Paste Supabase access token"
}

if (-not $Token) {
  throw "Supabase access token is required."
}

npx supabase login --token $Token

if ($DbPassword) {
  npx supabase link --project-ref $ProjectRef --password $DbPassword
} else {
  npx supabase link --project-ref $ProjectRef
}

Write-Host "Supabase CLI is ready for project $ProjectRef"
