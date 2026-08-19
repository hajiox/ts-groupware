import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { getUnreadSummary } from '@/lib/unread'

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ dmUnread: 0, groupUnread: 0, totalUnread: 0 }, { status: 401 })
  }

  return NextResponse.json(await getUnreadSummary(user.id))
}
