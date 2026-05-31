import { createClient, SupabaseClient } from '@supabase/supabase-js'

// 管理用クライアント（RLSバイパス、サーバーサイド専用）
// 環境変数未設定の場合はビルド時エラーを回避

let _adminClient: SupabaseClient | null = null

export function getAdminClient(): SupabaseClient {
  if (_adminClient) return _adminClient

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Supabase 環境変数が未設定です (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
  }

  _adminClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  return _adminClient
}

// 後方互換のための getter proxy
export const adminClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getAdminClient() as unknown as Record<string, unknown>)[prop as string]
  },
})
