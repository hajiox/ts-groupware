import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { getDeviceIdFromRequest, seedDeviceReadStatus } from '@/lib/read-status'

export async function POST(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { subscription } = body
    const deviceId = getDeviceIdFromRequest(request)

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return NextResponse.json({ error: '不正な購読データです' }, { status: 400 })
    }

    // 既存レコードを削除してから挿入
    await adminClient
      .from('gw_push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint)
      .eq('user_id', user.id)

    await seedDeviceReadStatus(user.id, deviceId)

    const subscriptionRow = {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_id: user.id,
      label: user.display_name,
      ...(deviceId ? { device_id: deviceId } : {}),
    }

    const { error } = await adminClient
      .from('gw_push_subscriptions')
      .insert(subscriptionRow)

    if (error && /device_id|schema cache/i.test(error.message || '')) {
      const { error: retryError } = await adminClient
        .from('gw_push_subscriptions')
        .insert({
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          user_id: user.id,
          label: user.display_name,
        })

      if (retryError) {
        return NextResponse.json({ error: retryError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const deviceId = getDeviceIdFromRequest(request)
    
    const query = adminClient
      .from('gw_push_subscriptions')
      .delete()
      .eq('user_id', user.id)

    if (body.endpoint) {
      query.eq('endpoint', body.endpoint)
    } else if (deviceId) {
      query.eq('device_id', deviceId)
    }
    
    await query
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: '購読の解除に失敗しました' }, { status: 500 })
  }
}
