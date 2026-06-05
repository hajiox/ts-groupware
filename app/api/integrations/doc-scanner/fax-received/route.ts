import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import { uploadFileToDrive } from '@/lib/drive'

type GroupRow = {
  id: string
  name: string
  type: string
}

type Attachment = {
  name?: string
  type?: string
  size?: number
  url?: string
  viewUrl?: string
  webViewLink?: string
  driveId?: string
  docScannerFileHash?: string
  dataBase64?: string
  encoding?: string
  sourceFileName?: string
  sourcePage?: number
  sourcePageCount?: number
}

type PostRow = {
  id: string
  group_id: string
  user_id: string
  content: string | null
  created_at: string
}

const DEFAULT_GROUP_NAMES = [
  'FAX受信',
  'ＦＡＸ受信',
  'ファックス受信',
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
    .replace(/Ｆ/g, 'F')
    .replace(/ｆ/g, 'f')
    .replace(/Ａ/g, 'A')
    .replace(/ａ/g, 'a')
    .replace(/Ｘ/g, 'X')
    .replace(/ｘ/g, 'x')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_FAX_RECEIVED_GROUP_NAME?.trim()
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
    return normalized.includes('受信') && (normalized.includes('fax') || normalized.includes('ファックス'))
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

function normalizeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      name: typeof item.name === 'string' ? item.name : 'FAX受信.jpg',
      type: typeof item.type === 'string' ? item.type : 'image/jpeg',
      size: typeof item.size === 'number' ? item.size : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
      viewUrl: typeof item.viewUrl === 'string' ? item.viewUrl : undefined,
      webViewLink: typeof item.webViewLink === 'string' ? item.webViewLink : undefined,
      driveId: typeof item.driveId === 'string' ? item.driveId : undefined,
      docScannerFileHash: typeof item.docScannerFileHash === 'string' ? item.docScannerFileHash : undefined,
      dataBase64: typeof item.dataBase64 === 'string' ? item.dataBase64 : undefined,
      encoding: typeof item.encoding === 'string' ? item.encoding : undefined,
      sourceFileName: typeof item.sourceFileName === 'string' ? item.sourceFileName : undefined,
      sourcePage: typeof item.sourcePage === 'number' ? item.sourcePage : undefined,
      sourcePageCount: typeof item.sourcePageCount === 'number' ? item.sourcePageCount : undefined,
    }))
    .filter(item => item.url || item.viewUrl || item.webViewLink || item.dataBase64)
}

const MAX_INCOMING_IMAGE_BYTES = 6 * 1024 * 1024

function normalizeBase64Payload(value: string) {
  const trimmed = value.trim()
  const commaIndex = trimmed.indexOf(',')
  if (commaIndex >= 0 && trimmed.slice(0, commaIndex).includes('base64')) {
    return trimmed.slice(commaIndex + 1)
  }
  return trimmed
}

async function storeIncomingImageAttachments(attachments: Attachment[]): Promise<Attachment[]> {
  const stored: Attachment[] = []

  for (const attachment of attachments) {
    if (!attachment.dataBase64) {
      stored.push(attachment)
      continue
    }

    if (!attachment.type?.startsWith('image/')) {
      throw new Error('FAX attachment must be an image')
    }

    const buffer = Buffer.from(normalizeBase64Payload(attachment.dataBase64), 'base64')
    if (buffer.length === 0) continue
    if (buffer.length > MAX_INCOMING_IMAGE_BYTES) {
      throw new Error(`FAX image is too large: ${attachment.name || 'image'}`)
    }

    const driveFile = await uploadFileToDrive(buffer, attachment.name || `FAX受信_${stored.length + 1}.jpg`, attachment.type)
    const fileUrl = driveFile.id
      ? `https://drive.google.com/uc?export=download&id=${driveFile.id}`
      : driveFile.webViewLink || ''
    const thumbnailUrl = driveFile.id
      ? `https://drive.google.com/thumbnail?id=${driveFile.id}&sz=w1600`
      : fileUrl

    stored.push({
      name: attachment.name,
      type: attachment.type,
      size: buffer.length,
      url: fileUrl,
      viewUrl: thumbnailUrl,
      webViewLink: driveFile.webViewLink || fileUrl,
      driveId: driveFile.id || undefined,
      docScannerFileHash: attachment.docScannerFileHash,
      sourceFileName: attachment.sourceFileName,
      sourcePage: attachment.sourcePage,
      sourcePageCount: attachment.sourcePageCount,
    })
  }

  return stored.filter(item => item.url || item.viewUrl || item.webViewLink)
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

function getBodyString(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'string' ? String(body[key]).trim() : ''
}

function buildContent(body: Record<string, unknown>, attachments: Attachment[]) {
  const sourceKey = getBodyString(body, 'sourceKey')
  const senderLabel = getBodyString(body, 'senderLabel') || getBodyString(body, 'from') || '不明'
  const subject = getBodyString(body, 'subject') || '(件名なし)'
  const imageCount = attachments.length

  return [
    '【FAX受信】',
    'eFAXで新しいFAXを受信しました。',
    '',
    `受信日時: ${formatDateTime(body.receivedAt)}`,
    `送信元: ${senderLabel}`,
    `件名: ${subject}`,
    imageCount ? `FAX画像: ${imageCount}枚添付` : '',
    sourceKey ? `受信ID: ${sourceKey}` : '',
  ].filter(Boolean).join('\n')
}

async function getExistingPost(groupId: string, userId: string, sourceKey: string, content: string) {
  if (sourceKey) {
    const { data, error } = await adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .ilike('content', `%受信ID: ${sourceKey}%`)
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
      { error: error instanceof Error ? error.message : 'Failed to load FAX received integration status' },
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
    const attachments = normalizeAttachments(bodyObject.attachments)

    if (attachments.length === 0) {
      return NextResponse.json({ error: 'attachments are required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const sourceKey = getBodyString(bodyObject, 'sourceKey')
    const content = buildContent(bodyObject, attachments)
    const existingPost = await getExistingPost(group.id, tsgUserId, sourceKey, content)

    if (existingPost) {
      const storedAttachments = await storeIncomingImageAttachments(attachments)

      if (storedAttachments.length > 0) {
        const { data: updatedPost, error: updateError } = await adminClient
          .from('gw_posts')
          .update({
            content,
            attachments: storedAttachments,
          })
          .eq('id', existingPost.id)
          .select('id, group_id, user_id, content, attachments, created_at')
          .single()

        if (updateError || !updatedPost) {
          return NextResponse.json({ error: updateError?.message || 'Failed to update FAX received post' }, { status: 500 })
        }

        await adminClient
          .from('gw_groups')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', group.id)

        return NextResponse.json({
          ok: true,
          duplicate: true,
          repaired: true,
          group: {
            id: group.id,
            name: group.name,
          },
          poster: {
            id: tsgUserId,
            displayName: 'TSG君',
          },
          post: updatedPost,
          url: `/board/${group.id}#post-${updatedPost.id}`,
        })
      }

      return NextResponse.json({
        ok: true,
        duplicate: true,
        repaired: false,
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

    const storedAttachments = await storeIncomingImageAttachments(attachments)
    if (storedAttachments.length === 0) {
      return NextResponse.json({ error: 'image attachments could not be stored' }, { status: 400 })
    }

    const { data: post, error } = await adminClient
      .from('gw_posts')
      .insert({
        group_id: group.id,
        user_id: tsgUserId,
        content,
        attachments: storedAttachments,
        parent_id: null,
      })
      .select('id, group_id, user_id, content, attachments, created_at')
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || 'Failed to create FAX received post' }, { status: 500 })
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
        tag: `tsg-doc-scanner-fax-received-${post.id}`,
      }, post.id))
      .catch(error => console.error('[DocScanner FAX received push error]', error))

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
      { error: error instanceof Error ? error.message : 'Failed to create FAX received post' },
      { status: 500 }
    )
  }
}
