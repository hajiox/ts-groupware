import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'

type GroupRow = {
  id: string
  name: string
  type: string
}

type PostRow = {
  id: string
  group_id: string
  user_id: string
  content: string | null
  created_at: string
}

type ProductInput = {
  name?: string | null
  price?: string | null
}

type RecipientInput = {
  name?: string | null
  methods?: unknown
  fax?: string | null
}

const DEFAULT_GROUP_NAMES = [
  'NEWブランド館（フロア）',
  'NEWブランド館(フロア)',
  'ＮＥＷブランド館（フロア）',
  'ＮＥＷブランド館(フロア)',
]

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function assertIntegrationSecret(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  if (actual !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

function normalizeGroupName(name: string) {
  return name
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/Ｎ/g, 'N')
    .replace(/ｎ/g, 'n')
    .replace(/Ｅ/g, 'E')
    .replace(/ｅ/g, 'e')
    .replace(/Ｗ/g, 'W')
    .replace(/ｗ/g, 'w')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_SALES_BROADCAST_GROUP_NAME?.trim()
  const targetNames = [...(configuredName ? [configuredName] : []), ...DEFAULT_GROUP_NAMES]
  const normalizedTargets = new Set(targetNames.map(normalizeGroupName))

  const { data: groups, error } = await adminClient
    .from('gw_groups')
    .select('id, name, type')
    .eq('type', 'board')

  if (error) throw new Error(error.message)

  const rows = (groups || []) as GroupRow[]
  const exact = rows.find(group => normalizedTargets.has(normalizeGroupName(group.name)))
  if (exact) return exact

  const fuzzy = rows.find(group => {
    const normalized = normalizeGroupName(group.name)
    return normalized.includes('new') && normalized.includes('ブランド館') && normalized.includes('フロア')
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

function getBodyString(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'string' ? String(body[key]).trim() : ''
}

function getBodyArray<T>(body: Record<string, unknown>, key: string): T[] {
  return Array.isArray(body[key]) ? body[key] as T[] : []
}

function formatDateTime(value: unknown) {
  const raw = typeof value === 'string' ? value : ''
  const date = raw ? new Date(raw) : new Date()
  if (Number.isNaN(date.getTime())) return raw || new Date().toLocaleString('ja-JP')

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function normalizeMethods(value: unknown) {
  if (!Array.isArray(value)) return ''
  return value.map(item => String(item || '').trim()).filter(Boolean).join(' / ')
}

function buildContent(body: Record<string, unknown>) {
  const type = getBodyString(body, 'type')
  const sourceKey = getBodyString(body, 'sourceKey')
  const subject = getBodyString(body, 'subject')
  const products = getBodyArray<ProductInput>(body, 'products')
    .map(product => {
      const name = String(product?.name || '').trim()
      const price = String(product?.price || '').trim()
      if (!name) return ''
      return price ? `- ${name}（${price}）` : `- ${name}`
    })
    .filter(Boolean)
  const recipients = getBodyArray<RecipientInput>(body, 'recipients')
    .map(recipient => {
      const name = String(recipient?.name || '').trim()
      if (!name) return ''
      const methods = normalizeMethods(recipient.methods)
      return methods ? `- ${name}（${methods}）` : `- ${name}`
    })
    .filter(Boolean)
  const summary = body.summary && typeof body.summary === 'object'
    ? body.summary as Record<string, unknown>
    : {}
  const success = Number(summary.success || 0)
  const failed = Number(summary.failed || 0)
  const total = Number(summary.total || recipients.length || 0)

  if (type === 'press_release' || sourceKey.startsWith('press-release:')) {
    return [
      '【プレスリリース一斉送信】',
      '地元メディア向けにプレスリリースをFAX送信しました。',
      '',
      subject ? `件名: ${subject}` : '',
      `送信日時: ${formatDateTime(body.sentAt)}`,
      Number.isFinite(total) && total > 0 ? `送信結果: 成功 ${success || 0}/${total}件${failed > 0 ? ` / 失敗 ${failed}件` : ''}` : '',
      '',
      '対象商品',
      products.length ? products.join('\n') : '- （対象商品なし）',
      '',
      '送信先一覧',
      recipients.length ? recipients.join('\n') : '- （送信先なし）',
      '',
      '取材依頼・掲載問い合わせがあった場合はご対応宜しくお願いいたします。',
      sourceKey ? `通知ID: ${sourceKey}` : '',
    ].filter(line => line !== '').join('\n')
  }

  return [
    '【営業FAX一斉送信】',
    '営業FAXを一斉送信しました。',
    '',
    subject ? `件名: ${subject}` : '',
    `送信日時: ${formatDateTime(body.sentAt)}`,
    Number.isFinite(total) && total > 0 ? `送信結果: 成功 ${success || 0}/${total}件${failed > 0 ? ` / 失敗 ${failed}件` : ''}` : '',
    '',
    '提案商品名',
    products.length ? products.join('\n') : '- （提案商品なし）',
    '',
    '送信先一覧',
    recipients.length ? recipients.join('\n') : '- （送信先なし）',
    '',
    'お客様よりサンプル依頼、問い合わせがあった場合はご対応宜しくお願いいたします。',
    sourceKey ? `通知ID: ${sourceKey}` : '',
  ].filter(line => line !== '').join('\n')
}

async function getExistingPost(groupId: string, userId: string, sourceKey: string, content: string) {
  if (sourceKey) {
    const { data, error } = await adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .ilike('content', `%通知ID: ${sourceKey}%`)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) throw new Error(error.message)
    const existing = ((data || []) as PostRow[])[0]
    if (existing) return existing
  }

  const { data, error } = await adminClient
    .from('gw_posts')
    .select('id, group_id, user_id, content, created_at')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('content', content)
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(error.message)
  return ((data || []) as PostRow[])[0] || null
}

export async function GET(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    return NextResponse.json({
      group: {
        id: group.id,
        name: group.name,
      },
      poster: {
        id: tsgUserId,
        displayName: 'TSG君',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load sales broadcast integration status' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const bodyObject = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const sourceKey = getBodyString(bodyObject, 'sourceKey')
    const content = buildContent(bodyObject)

    if (!sourceKey) {
      return NextResponse.json({ error: 'sourceKey is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const existingPost = await getExistingPost(group.id, tsgUserId, sourceKey, content)
    if (existingPost) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        group: {
          id: group.id,
          name: group.name,
        },
        poster: {
          id: tsgUserId,
          displayName: 'TSG君',
        },
        post: existingPost,
        url: `/board/${group.id}#post-${existingPost.id}`,
      })
    }

    const { data: post, error } = await adminClient
      .from('gw_posts')
      .insert({
        group_id: group.id,
        user_id: tsgUserId,
        content,
        attachments: [],
        parent_id: null,
      })
      .select('id, group_id, user_id, content, created_at')
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || 'Failed to create sales broadcast post' }, { status: 500 })
    }

    await adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group.id)

    await import('@/lib/web-push')
      .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, tsgUserId, {
        title: `${group.name} - TSG君`,
        body: content.substring(0, 80),
        url: `/board/${group.id}#post-${post.id}`,
        tag: `tsg-doc-scanner-sales-broadcast-${post.id}`,
      }, post.id))
      .catch(error => console.error('[DocScanner sales broadcast push error]', error))

    return NextResponse.json({
      ok: true,
      duplicate: false,
      group: {
        id: group.id,
        name: group.name,
      },
      poster: {
        id: tsgUserId,
        displayName: 'TSG君',
      },
      post,
      url: `/board/${group.id}#post-${post.id}`,
    }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create sales broadcast post' },
      { status: 500 }
    )
  }
}
