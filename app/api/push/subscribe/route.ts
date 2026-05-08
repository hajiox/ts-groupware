import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

export async function POST(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { subscription } = body

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return NextResponse.json({ error: '不正な購読データです' }, { status: 400 })
    }

    // 既存レコードを削除してから挿入
    await adminClient
      .from('gw_push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint)
      .eq('user_id', user.id)

    const { error } = await adminClient
      .from('gw_push_subscriptions')
      .insert({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_id: user.id,
        label: user.display_name,
      })

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
    
    const query = adminClient
      .from('gw_push_subscriptions')
      .delete()
      .eq('user_id', user.id)

    if (body.endpoint) {
      query.eq('endpoint', body.endpoint)
    }
    
    await query
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: '購読の解除に失敗しました' }, { status: 500 })
  }
}
