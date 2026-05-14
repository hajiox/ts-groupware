param(
  [string]$DbUrl = ""
)

$ErrorActionPreference = "Stop"
$File = "scripts/supabase-tsg-check-device-read.sql"

if ($DbUrl) {
  npx supabase db query --db-url $DbUrl --file $File --output table
} else {
  npx supabase db query --linked --file $File --output table
}
