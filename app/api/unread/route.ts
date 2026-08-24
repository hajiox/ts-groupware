import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { getUnreadSummary } from '@/lib/unread'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  Vary: 'Cookie',
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json(
      { dmUnread: 0, groupUnread: 0, totalUnread: 0 },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  return NextResponse.json(
    await getUnreadSummary(user.id),
    { headers: PRIVATE_NO_STORE_HEADERS },
  )
}
