import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { getDeviceIdFromRequest } from '@/lib/read-status'

export async function POST(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const endpoint = body.endpoint
  const deviceId = getDeviceIdFromRequest(request)

  if (!endpoint) {
    return NextResponse.json({ subscribed: false })
  }

  let query = adminClient
    .from('gw_push_subscriptions')
    .select('id')
    .eq('user_id', user.id)
    .eq('endpoint', endpoint)

  if (deviceId) {
    query = query.eq('device_id', deviceId)
  }

  let { data, error } = await query.maybeSingle()

  if (error && deviceId && /device_id|schema cache/i.test(error.message || '')) {
    const fallback = await adminClient
      .from('gw_push_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('endpoint', endpoint)
      .maybeSingle()

    data = fallback.data
    error = fallback.error
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ subscribed: !!data })
}
