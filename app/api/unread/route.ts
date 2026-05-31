import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { getUnreadSummary } from '@/lib/unread'
import { getDeviceIdFromRequest } from '@/lib/read-status'
import { withTimeout } from '@/lib/timeout'

export async function GET(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ dmUnread: 0, groupUnread: 0, totalUnread: 0 }, { status: 401 })
  }

  const summary = await withTimeout(
    getUnreadSummary(user.id, getDeviceIdFromRequest(request)),
    8000,
    { dmUnread: 0, groupUnread: 0, totalUnread: 0 },
    'unread summary'
  )

  return NextResponse.json(summary)
}
