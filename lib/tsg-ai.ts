import { adminClient } from '@/lib/supabase/admin'

/**
 * TSG君 AI応答モジュール
 *
 * DM（Direct Chat）でTSG君宛にメッセージが来た場合、
 * Gemini 3.1 Flash-Lite でAI応答を生成しTSG君名義で返信する。
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = 'gemini-3.1-flash-lite'
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`

const SYSTEM_PROMPT = `あなたは「TSG君」という名前の社内AIアシスタントです。
会津食のブランド館（TS）の社内グループウェア「TS Groupware」で働いています。

ルール:
- 丁寧だが堅すぎない自然な日本語で話す
- 簡潔に回答する（長くなりすぎない）
- 社内の業務サポート、質問への回答、アイデア出しなどを行う
- わからないことは正直に「わかりません」と答える
- 絵文字を適度に使って親しみやすく
- 機密情報や個人情報について聞かれたら回答を控える`

// レート制限: ユーザーごとの最終リクエスト時刻を管理
const rateLimitMap = new Map<string, number[]>()
const RATE_LIMIT_WINDOW = 60_000 // 1分
const RATE_LIMIT_MAX = 5 // 1分に5回まで

function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const timestamps = rateLimitMap.get(userId) || []
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW)

  if (recent.length >= RATE_LIMIT_MAX) {
    return false
  }

  recent.push(now)
  rateLimitMap.set(userId, recent)
  return true
}

/**
 * TSG君のユーザーIDを取得
 */
let cachedTsgId: string | null = null
export async function getTsgUserId(): Promise<string | null> {
  if (cachedTsgId) return cachedTsgId

  const { data } = await adminClient
    .from('gw_users')
    .select('id')
    .eq('display_name', 'TSG君')
    .single()

  if (data) cachedTsgId = data.id
  return cachedTsgId
}

/**
 * 指定グループがTSG君とのDMかどうか判定
 */
export async function isTsgDirectChat(groupId: string): Promise<boolean> {
  const tsgId = await getTsgUserId()
  if (!tsgId) return false

  const { data: group } = await adminClient
    .from('gw_groups')
    .select('description, type')
    .eq('id', groupId)
    .single()

  if (!group || group.type !== 'chat') return false

  // direct:userId1,userId2 形式のDM
  if (typeof group.description === 'string' && group.description.startsWith('direct:')) {
    const userIds = group.description.replace('direct:', '').split(',')
    return userIds.includes(tsgId)
  }

  // グループチャットでTSG君がメンバーの場合も対応
  const { data: membership } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', tsgId)
    .single()

  return !!membership
}

/**
 * チャット履歴を取得してGemini用のメッセージ配列に変換
 */
async function buildConversationHistory(groupId: string, tsgId: string) {
  const { data: messages } = await adminClient
    .from('gw_posts')
    .select('user_id, content, created_at')
    .eq('group_id', groupId)
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .limit(20) // 直近20件

  if (!messages || messages.length === 0) return []

  // 古い順に並べ替え
  const sorted = [...messages].reverse()

  return sorted
    .filter(m => m.content)
    .map(m => ({
      role: m.user_id === tsgId ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
}

/**
 * Gemini APIを呼び出してAI応答を生成
 */
async function callGemini(conversationHistory: { role: string; parts: { text: string }[] }[]): Promise<string> {
  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: conversationHistory,
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.7,
      },
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error('[TSG AI] Gemini API error:', response.status, err)
    throw new Error('AI応答の生成に失敗しました')
  }

  const data = await response.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error('AI応答が空でした')
  }

  return text.trim()
}

/**
 * TSG君としてAI応答を投稿
 */
async function postAsTsg(groupId: string, content: string) {
  const tsgId = await getTsgUserId()
  if (!tsgId) return

  await adminClient
    .from('gw_posts')
    .insert({
      group_id: groupId,
      user_id: tsgId,
      content,
      attachments: [],
      parent_id: null,
    })

  // グループのupdated_atを更新
  await adminClient
    .from('gw_groups')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', groupId)
}

/**
 * メインエントリ: ユーザーのメッセージに対してTSG君がAI応答を返す
 *
 * チャットAPIのPOST後に非同期で呼び出す。
 * 応答はポーリングで自動的にクライアントに届く。
 */
export async function handleTsgAiResponse(groupId: string, senderUserId: string): Promise<void> {
  if (!GEMINI_API_KEY) {
    console.error('[TSG AI] GEMINI_API_KEY not configured')
    return
  }

  const tsgId = await getTsgUserId()
  if (!tsgId) {
    console.error('[TSG AI] TSG君 user not found')
    return
  }

  // TSG君自身のメッセージには応答しない
  if (senderUserId === tsgId) return

  // レート制限チェック
  if (!checkRateLimit(senderUserId)) {
    await postAsTsg(groupId, '⚠️ メッセージの送信が早すぎます。少し待ってからもう一度お試しください。')
    return
  }

  try {
    // 会話履歴を構築
    const history = await buildConversationHistory(groupId, tsgId)
    if (history.length === 0) return

    // Gemini呼び出し
    const aiResponse = await callGemini(history)

    // 応答を投稿
    await postAsTsg(groupId, aiResponse)
  } catch (err) {
    console.error('[TSG AI] Error:', err)
    await postAsTsg(groupId, '申し訳ありません、エラーが発生しました 🙇 もう一度お試しください。')
  }
}
