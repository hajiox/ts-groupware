import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { sendPushNotificationToUser } from '@/lib/web-push'

export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false
  return request.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: 'Cron is not configured' }, { status: 503 })
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [messagesResult, pledgesResult] = await Promise.all([
    adminClient.rpc('gw_dispatch_new_hire_company_messages'),
    adminClient.rpc('gw_dispatch_new_hire_pledges'),
  ])
  const pledgeRows = (pledgesResult.error ? [] : pledgesResult.data || []) as Array<{
    assignment_id: string
    user_id: string
    pledge_title: string
  }>
  const pushResults = await Promise.allSettled(pledgeRows.map((pledge) => sendPushNotificationToUser(pledge.user_id, {
    title: '誓約書が届いています',
    body: pledge.pledge_title,
    url: '/groups',
    tag: `tsg-new-hire-pledge-${pledge.assignment_id}`,
  })))
  const pushFailures = pushResults.filter((result) => result.status === 'rejected').length
  if (pushFailures > 0) {
    console.error(`new hire pledge push failed for ${pushFailures} recipient(s)`)
  }

  if (messagesResult.error || pledgesResult.error) {
    if (messagesResult.error) console.error('new hire company message cron failed', messagesResult.error)
    if (pledgesResult.error) console.error('new hire pledge cron failed', pledgesResult.error)
    return NextResponse.json({ error: 'Dispatch failed' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    delivered: messagesResult.data?.length || 0,
    pledges: pledgeRows.length,
    pledgePushFailures: pushFailures,
  })
}
