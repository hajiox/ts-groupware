import { createClient } from '@supabase/supabase-js'

// ブラウザ用クライアント（anon key、RLS適用）
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
