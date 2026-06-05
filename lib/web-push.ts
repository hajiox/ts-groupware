/**
 * Web Push 通知ユーティリティ
 *
 * 責務: VAPID認証によるWeb Push通知の送信。
 * push_subscriptions テーブルに登録された全端末にプッシュ通知を送信する。
 */

import webpush from 'web-push'
import { adminClient } from '@/lib/supabase/admin'
import { getUnreadSummary } from '@/lib/unread'

let vapidInitialized = false

function ensureVapidSetup(): boolean {
  if (vapidInitialized) return true

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''
  const privateKey = process.env.VAPID_PRIVATE_KEY || ''
  const subject = process.env.NEXT_PUBLIC_SITE_URL || 'https://ts-groupware.vercel.app'

  if (!publicKey || !privateKey) {
    return false
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    vapidInitialized = true
    return true
  } catch (err) {
    console.error('[WebPush] VAPID初期化エラー:', err)
    return false
  }
}

type PushPayload = {
  title: string
  body: string
  url?: string
  tag?: string
  icon?: string
  badgeCount?: number
}

type GroupPushOptions = {
  excludeUserIds?: string[]
}

/**
 * 登録済みの全端末にプッシュ通知を送信
 */
export async function sendPushNotificationToAll(payload: PushPayload): Promise<void> {
  await _sendToSubscriptions(null, payload)
}

/**
 * 特定ユーザーの登録済み端末にプッシュ通知を送信
 * postIdが指定された場合、ユーザーがその投稿（スレッド）をミュートしていれば送らない
 */
export async function sendPushNotificationToUser(userId: string, payload: PushPayload, postId?: string): Promise<void> {
  if (postId) {
    const { data: muteRow } = await adminClient
      .from('gw_post_notification_settings')
      .select('muted')
      .eq('user_id', userId)
      .eq('post_id', postId)
      .single()

    if (muteRow && muteRow.muted) {
      return // ミュート中
    }
  }

  await _sendToSubscriptions(userId, payload)
}

/**
 * 特定のグループのメンバーにのみプッシュ通知を送信
 * ただし、送信元ユーザー（senderId）と通知ミュート中のユーザーには送らない
 * postIdが指定された場合、その投稿（スレッド）を個別にミュートしているユーザーも除外する
 */
export async function sendPushNotificationToGroup(
  groupId: string,
  senderId: string,
  payload: PushPayload,
  postId?: string,
  options: GroupPushOptions = {}
): Promise<void> {
  // グループのメンバー取得
  const { data: members } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', groupId)

  if (!members || members.length === 0) return

  const excludedIds = new Set([senderId, ...(options.excludeUserIds || [])])
  let userIds = members.map(m => m.user_id).filter(id => !excludedIds.has(id))

  if (userIds.length === 0) return

  // 1. グループ単位の通知ミュート設定を確認し、muted=true のユーザーを除外
  const { data: mutedRows } = await adminClient
    .from('gw_notification_settings')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('muted', true)
    .in('user_id', userIds)

  if (mutedRows && mutedRows.length > 0) {
    const mutedIds = new Set(mutedRows.map(r => r.user_id))
    userIds = userIds.filter(id => !mutedIds.has(id))
  }

  if (userIds.length === 0) return

  // 2. 投稿単位の通知ミュート設定を確認し、muted=true のユーザーを除外（postIdがある場合）
  if (postId) {
    const { data: postMutedRows } = await adminClient
      .from('gw_post_notification_settings')
      .select('user_id')
      .eq('post_id', postId)
      .eq('muted', true)
      .in('user_id', userIds)

    if (postMutedRows && postMutedRows.length > 0) {
      const postMutedIds = new Set(postMutedRows.map(r => r.user_id))
      userIds = userIds.filter(id => !postMutedIds.has(id))
    }
  }

  if (userIds.length === 0) return

  // メンバーの購読情報を取得
  let { data: subscriptions, error: subscriptionError } = await adminClient
    .from('gw_push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_id, device_id')
    .in('user_id', userIds)
  let subscriptionRows: any[] | null = subscriptions

  if (subscriptionError && /device_id|schema cache/i.test(subscriptionError.message || '')) {
    const fallback = await adminClient
      .from('gw_push_subscriptions')
      .select('id, endpoint, p256dh, auth, user_id')
      .in('user_id', userIds)
    subscriptionRows = fallback.data
    subscriptionError = fallback.error
  }

  if (!subscriptionError && subscriptionRows && subscriptionRows.length > 0) {
    await _executeSend(subscriptionRows, payload)
  }
}

/**
 * 内部共通: 指定された全購読（レコードが無い場合は全端末）に送信
 */
async function _sendToSubscriptions(userId: string | null, payload: PushPayload): Promise<void> {
  let query = adminClient
    .from('gw_push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_id, device_id')

  if (userId) {
    query = query.eq('user_id', userId)
  }

  let { data: subscriptions, error } = await query
  let subscriptionRows: any[] | null = subscriptions

  if (error && /device_id|schema cache/i.test(error.message || '')) {
    let fallbackQuery = adminClient
      .from('gw_push_subscriptions')
      .select('id, endpoint, p256dh, auth, user_id')

    if (userId) {
      fallbackQuery = fallbackQuery.eq('user_id', userId)
    }

    const fallback = await fallbackQuery
    subscriptionRows = fallback.data
    error = fallback.error
  }

  if (error || !subscriptionRows || subscriptionRows.length === 0) {
    return
  }

  await _executeSend(subscriptionRows, payload)
}

async function _executeSend(subscriptions: any[], payload: PushPayload): Promise<void> {
  if (!ensureVapidSetup()) {
    console.warn('[WebPush] VAPID鍵が未設定のため送信スキップ')
    return
  }

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        const badgeCount = payload.badgeCount ?? (sub.user_id
          ? (await getUnreadSummary(sub.user_id, sub.device_id)).totalUnread
          : undefined)
        const notificationPayload = JSON.stringify({
          title: payload.title,
          body: payload.body,
          url: payload.url || '/groups',
          tag: payload.tag || 'ts-groupware-' + Date.now(),
          icon: payload.icon || '/icon-192.png',
          badgeCount,
        })

        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          },
          notificationPayload
        )
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 410 || statusCode === 404) {
          // 無効な購読を削除
          await adminClient
            .from('gw_push_subscriptions')
            .delete()
            .eq('id', sub.id)
        }
        throw err
      }
    })
  )

  const failed = results
    .map((result, index) => ({ result, sub: subscriptions[index] }))
    .filter(({ result }) => result.status === 'rejected')

  for (const { result, sub } of failed) {
    const reason = result.status === 'rejected' ? result.reason : null
    console.error('[WebPush] 送信失敗:', {
      subscriptionId: sub.id,
      userId: sub.user_id,
      statusCode: reason?.statusCode,
      message: reason instanceof Error ? reason.message : String(reason),
    })
  }

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  console.log(`[WebPush] 送信完了: ${succeeded}/${subscriptions.length}`)
}
