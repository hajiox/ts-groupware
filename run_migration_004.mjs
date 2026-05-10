import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// .env.local を手動パース
const envContent = readFileSync('.env.local', 'utf8')
const envVars = {}
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx > 0) {
    const key = trimmed.substring(0, eqIdx)
    let val = trimmed.substring(eqIdx + 1)
    // Remove surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    envVars[key] = val
  }
}

const url = envVars.NEXT_PUBLIC_SUPABASE_URL
const key = envVars.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing SUPABASE env vars')
  process.exit(1)
}

const supabase = createClient(url, key)

async function run() {
  // テーブルが存在するかチェック
  const { data, error } = await supabase
    .from('gw_notification_settings')
    .select('user_id')
    .limit(1)

  if (!error) {
    console.log('OK: gw_notification_settings table already exists.')
    return
  }

  console.log('Table does not exist yet:', error.message)
  console.log('')
  console.log('=== Please run this SQL in Supabase SQL Editor ===')
  console.log(readFileSync('sql/004_notification_settings.sql', 'utf8'))
  console.log('=== Supabase Dashboard URL ===')
  console.log('https://supabase.com/dashboard/project/zfhswguzqyagmhhlpksq/sql')
}

run()
