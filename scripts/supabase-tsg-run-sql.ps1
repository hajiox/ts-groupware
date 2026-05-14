param(
  [string]$File = "sql/008_device_read_status.sql",
  [string]$DbUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $File)) {
  throw "SQL file not found: $File"
}

if ($DbUrl) {
  npx supabase db query --db-url $DbUrl --file $File --output table
} else {
  npx supabase db query --linked --file $File --output table
}
