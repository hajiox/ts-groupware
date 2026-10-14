import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import { uploadFileToDrive } from '@/lib/drive'
import {
  buildFaxReceivedPostContent,
  isFaxSummaryStatus,
  normalizeFaxSummaryText,
  preserveResolvedFaxSummary,
  updateFaxSummaryInContent,
} from '@/lib/doc-scanner-fax-post'
import {
  FaxImageInputError,
  normalizeFaxImageBuffer,
  parseFaxOrientationReceipt,
  type FaxOrientationReceipt,
} from '@/lib/doc-scanner-fax-image'

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
  rotationCorrected?: boolean
  rotationReason?: string
  orientation?: FaxOrientationReceipt
  receivedSha256?: string
  storedSha256?: string
}

function getStringValue(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function getNumberValue(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

function isDataImageUrl(value?: string) {
  return !!value && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim())
}

function isHttpUrl(value?: string) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

type PostRow = {
  id: string
  group_id: string
  user_id: string
  content: string | null
  created_at: string
  attachments?: unknown
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
    .map(item => {
      const url = getStringValue(item, ['url', 'downloadUrl', 'download_url'])
      const viewUrl = getStringValue(item, ['viewUrl', 'view_url', 'previewUrl', 'preview_url'])
      const webViewLink = getStringValue(item, ['webViewLink', 'web_view_link', 'webContentLink', 'web_content_link'])
      const dataBase64 =
        getStringValue(item, ['dataBase64', 'data_base64', 'contentBase64', 'content_base64', 'base64', 'data', 'content']) ||
        (isDataImageUrl(url) ? url : undefined) ||
        (isDataImageUrl(viewUrl) ? viewUrl : undefined)

      const sourcePage = getNumberValue(item, ['sourcePage', 'source_page'])
      const sourcePageCount = getNumberValue(item, ['sourcePageCount', 'source_page_count'])
      if (item.orientation !== undefined && sourcePageCount === undefined
        && ['sourcePageCount', 'source_page_count'].some(key => Object.prototype.hasOwnProperty.call(item, key))) {
        throw new FaxImageInputError('FAX orientation receipt is invalid')
      }
      const orientation = parseFaxOrientationReceipt(item.orientation, sourcePage, sourcePageCount)
      return {
        name: getStringValue(item, ['name', 'fileName', 'filename']) || 'FAX受信.jpg',
        type: getStringValue(item, ['type', 'mimeType', 'mime_type', 'contentType', 'content_type']) || 'image/jpeg',
        size: getNumberValue(item, ['size', 'fileSize', 'file_size']),
        url,
        viewUrl,
        webViewLink,
        driveId: getStringValue(item, ['driveId', 'drive_id']),
        docScannerFileHash: getStringValue(item, ['docScannerFileHash', 'doc_scanner_file_hash', 'fileHash', 'file_hash']),
        dataBase64,
        encoding: getStringValue(item, ['encoding']),
        sourceFileName: getStringValue(item, ['sourceFileName', 'source_file_name']),
        sourcePage,
        sourcePageCount,
        orientation,
      }
    })
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

function getJpegAttachmentName(name: string | undefined, fallback: string) {
  const rawName = (name || fallback).trim() || fallback
  return rawName.replace(/\.[^.]+$/, '') + '.jpg'
}

async function fetchIncomingImageAttachment(attachment: Attachment) {
  const sourceUrl = [attachment.url, attachment.viewUrl, attachment.webViewLink].find(isHttpUrl)
  if (!sourceUrl) return null

  const response = await fetch(sourceUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`FAX image could not be fetched: ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || attachment.type || ''
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`FAX attachment URL is not an image: ${contentType || 'unknown'}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

async function storeIncomingImageAttachments(attachments: Attachment[], requireImageBytes = false): Promise<Attachment[]> {
  const prepared: { attachment: Attachment; image?: Awaited<ReturnType<typeof normalizeFaxImageBuffer>> }[] = []
  // Validate every receipt and image before creating any Drive file.
  for (const attachment of attachments) {
    if (!attachment.dataBase64 && attachment.driveId && !attachment.orientation && !requireImageBytes) {
      prepared.push({ attachment })
      continue
    }

    if (!attachment.type?.startsWith('image/')) {
      throw new FaxImageInputError('FAX attachment must be an image')
    }

    const buffer = attachment.dataBase64
      ? Buffer.from(normalizeBase64Payload(attachment.dataBase64), 'base64')
      : await fetchIncomingImageAttachment(attachment)

    if (!buffer) {
      if (attachment.orientation || requireImageBytes) throw new FaxImageInputError('FAX image bytes are required')
      continue
    }

    if (buffer.length === 0) {
      if (attachment.orientation || requireImageBytes) throw new FaxImageInputError('FAX image bytes are required')
      continue
    }
    if (buffer.length > MAX_INCOMING_IMAGE_BYTES) {
      throw new FaxImageInputError('FAX image is too large')
    }
    const image = await normalizeFaxImageBuffer(buffer, attachment.orientation)
    prepared.push({ attachment, image })
  }
  const stored: Attachment[] = []
  for (const { attachment, image: normalizedImage } of prepared) {
    if (!normalizedImage) {
      stored.push(attachment)
      continue
    }
    const uploadName = getJpegAttachmentName(attachment.name, `FAX受信_${stored.length + 1}.jpg`)
    const driveFile = await uploadFileToDrive(normalizedImage.buffer, uploadName, normalizedImage.type)
    const fileUrl = driveFile.id
      ? `https://drive.google.com/uc?export=download&id=${driveFile.id}`
      : driveFile.webViewLink || ''
    const thumbnailUrl = driveFile.id
      ? `https://drive.google.com/thumbnail?id=${driveFile.id}&sz=w1600`
      : fileUrl

    stored.push({
      name: uploadName,
      type: normalizedImage.type,
      size: normalizedImage.buffer.length,
      url: fileUrl,
      viewUrl: thumbnailUrl,
      webViewLink: driveFile.webViewLink || fileUrl,
      driveId: driveFile.id || undefined,
      docScannerFileHash: attachment.docScannerFileHash,
      sourceFileName: attachment.sourceFileName,
      sourcePage: attachment.sourcePage,
      sourcePageCount: attachment.sourcePageCount,
      orientation: attachment.orientation,
      receivedSha256: normalizedImage.receivedSha256,
      storedSha256: normalizedImage.storedSha256,
      rotationCorrected: normalizedImage.rotationCorrected || undefined,
      rotationReason: normalizedImage.rotationReason,
    })
  }

  return stored.filter(item => item.url || item.viewUrl || item.webViewLink)
}

function getBodyString(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'string' ? String(body[key]).trim() : ''
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

async function repairFaxAttachments(
  body: Record<string, unknown>, attachments: Attachment[], group: GroupRow, tsgUserId: string,
) {
  const postId = getBodyString(body, 'postId')
  const sourceKey = getBodyString(body, 'sourceKey')
  const expectedDriveIds = body.expectedDriveIds
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(postId)
    || !sourceKey || /[\r\n\0]/.test(sourceKey)
    || !Array.isArray(expectedDriveIds)
    || !expectedDriveIds.every(value => typeof value === 'string' && value.length > 0 && value.trim() === value)) {
    return NextResponse.json({ error: 'Repair postId, sourceKey, and expectedDriveIds are required' }, { status: 400 })
  }
  const { data, error } = await adminClient.from('gw_posts')
    .select('id, group_id, user_id, content, attachments, created_at')
    .eq('id', postId).eq('group_id', group.id).eq('user_id', tsgUserId).is('parent_id', null).maybeSingle()
  if (error) throw new Error('Failed to read FAX repair target')
  const post = data as PostRow | null
  if (!post) return NextResponse.json({ error: 'FAX repair target was not found' }, { status: 404 })
  const sourceLines = (post.content || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(line => line.startsWith('受信ID:'))
  if (sourceLines.length !== 1 || sourceLines[0] !== `受信ID: ${sourceKey}`) {
    return NextResponse.json({ error: 'FAX repair sourceKey conflict' }, { status: 409 })
  }
  const currentAttachments = post.attachments
  if (!Array.isArray(currentAttachments) || currentAttachments.length !== expectedDriveIds.length
    || attachments.length !== currentAttachments.length
    || currentAttachments.some((item, index) => !item || typeof item !== 'object'
      || item.driveId !== expectedDriveIds[index]
      || (item.sourcePage !== undefined && item.sourcePage !== attachments[index].sourcePage)
      || (item.sourcePageCount !== undefined && item.sourcePageCount !== attachments[index].sourcePageCount)
      || (item.docScannerFileHash !== undefined && item.docScannerFileHash !== attachments[index].docScannerFileHash))) {
    return NextResponse.json({ error: 'FAX repair attachments conflict' }, { status: 409 })
  }
  const storedAttachments = await storeIncomingImageAttachments(attachments, true)
  if (storedAttachments.length !== attachments.length) {
    return NextResponse.json({ error: 'FAX repair images could not be stored' }, { status: 400 })
  }
  const { data: updatedPost, error: updateError } = await adminClient.from('gw_posts')
    .update({ attachments: storedAttachments })
    .eq('id', post.id).eq('group_id', group.id).eq('user_id', tsgUserId).is('parent_id', null)
    // Compare the complete JSONb snapshot, including ordering and metadata. A
    // concurrent attachment edit must not be overwritten after Drive uploads.
    .eq('attachments', JSON.stringify(currentAttachments))
    .select('id, group_id, user_id, content, attachments, created_at').maybeSingle()
  if (updateError) throw new Error('Failed to repair FAX attachments')
  if (!updatedPost) return NextResponse.json({ error: 'FAX repair attachments conflict' }, { status: 409 })
  await adminClient.from('gw_groups').update({ updated_at: new Date().toISOString() }).eq('id', group.id)
  return NextResponse.json({
    ok: true, duplicate: true, repaired: true,
    group: { id: group.id, name: group.name },
    poster: { id: tsgUserId, displayName: 'TSG君' },
    post: updatedPost, url: `/board/${group.id}#post-${updatedPost.id}`,
  })
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
      capabilities: { orientationReceiptVersion: 2, semanticRotation: false, repairAttachments: true },
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

    if (bodyObject.action === 'repair-attachments') {
      return await repairFaxAttachments(bodyObject, attachments, group, tsgUserId)
    }

    const sourceKey = getBodyString(bodyObject, 'sourceKey')
    const summaryStatus = isFaxSummaryStatus(bodyObject.summaryStatus) ? bodyObject.summaryStatus : 'pending'
    const content = buildFaxReceivedPostContent({
      sourceKey,
      senderLabel: getBodyString(bodyObject, 'senderLabel'),
      from: getBodyString(bodyObject, 'from'),
      subject: getBodyString(bodyObject, 'subject'),
      receivedAt: bodyObject.receivedAt,
      imageCount: attachments.length,
      summaryStatus,
      summary: normalizeFaxSummaryText(bodyObject.summary),
    })
    const existingPost = await getExistingPost(group.id, tsgUserId, sourceKey, content)

    if (existingPost) {
      const storedAttachments = await storeIncomingImageAttachments(attachments)
      const mergedContent = preserveResolvedFaxSummary(existingPost.content, content)

      if (storedAttachments.length > 0) {
        const { data: updatedPost, error: updateError } = await adminClient
          .from('gw_posts')
          .update({
            content: mergedContent,
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
      { status: error instanceof FaxImageInputError ? 400 : 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const bodyObject = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const sourceKey = getBodyString(bodyObject, 'sourceKey')
    const summaryStatus = bodyObject.summaryStatus
    const summary = normalizeFaxSummaryText(bodyObject.summary)

    if (!sourceKey) return NextResponse.json({ error: 'sourceKey is required' }, { status: 400 })
    if (!isFaxSummaryStatus(summaryStatus) || summaryStatus === 'pending') {
      return NextResponse.json({ error: 'summaryStatus must be completed, needs_review, or failed' }, { status: 400 })
    }
    if (summaryStatus !== 'failed' && !summary) {
      return NextResponse.json({ error: 'summary is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()
    if (!tsgUserId) return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })

    const post = await getExistingPost(group.id, tsgUserId, sourceKey, '')
    if (!post) return NextResponse.json({ error: 'FAX received post was not found' }, { status: 404 })

    const content = updateFaxSummaryInContent(post.content, summaryStatus, summary)
    if (content === post.content) {
      return NextResponse.json({ ok: true, unchanged: true, post })
    }

    const { data: updatedPost, error } = await adminClient
      .from('gw_posts')
      .update({ content })
      .eq('id', post.id)
      .select('id, group_id, user_id, content, attachments, created_at')
      .single()
    if (error || !updatedPost) {
      return NextResponse.json({ error: error?.message || 'Failed to update FAX summary' }, { status: 500 })
    }

    await adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group.id)

    return NextResponse.json({
      ok: true,
      unchanged: false,
      post: updatedPost,
      url: `/board/${group.id}#post-${updatedPost.id}`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update FAX summary' },
      { status: 500 }
    )
  }
}
