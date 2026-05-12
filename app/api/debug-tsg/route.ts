import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

// デバッグ用 — TSG AI パイプライン診断
export async function GET() {
  const results: Record<string, unknown> = {}

  // 1. TSG君ユーザー検索
  const { data: tsgByName, error: e1 } = await adminClient
    .from('gw_users')
    .select('id, display_name, line_user_id')
    .eq('display_name', 'TSG君')
    .single()
  results.tsgByName = tsgByName
  results.tsgByNameError = e1?.message || null

  // real_name でも検索
  const { data: tsgByReal } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, line_user_id')
    .or('real_name.eq.TSG君,display_name.ilike.%TSG%')
  results.tsgByRealOrLike = tsgByReal

  // 2. direct chat グループ一覧
  const { data: directGroups } = await adminClient
    .from('gw_groups')
    .select('id, name, description, type')
    .eq('type', 'chat')
    .like('description', 'direct:%')
  results.directChatGroups = directGroups

  // 3. GEMINI_API_KEY チェック
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  results.geminiKeyExists = !!apiKey
  results.geminiKeyLength = apiKey?.length || 0
  results.geminiKeyPrefix = apiKey?.substring(0, 10) || 'N/A'

  // 4. Gemini API 疎通テスト
  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say hello in Japanese' }] }],
          generationConfig: { maxOutputTokens: 30 },
        }),
      })
      results.geminiStatus = res.status
      const data = await res.json()
      if (res.ok) {
        results.geminiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text
      } else {
        results.geminiError = data
      }
    } catch (e) {
      results.geminiFetchError = (e as Error).message
    }
  }

  return NextResponse.json(results, { status: 200 })
}
