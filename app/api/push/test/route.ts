import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { sendPushNotificationToUser } from '@/lib/web-push'

export async function POST() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  await sendPushNotificationToUser(user.id, {
    title: 'TS Groupware',
    body: 'テスト通知です。通知設定は有効です。',
    url: '/settings',
    tag: `tsg-test-${user.id}`,
  })

  return NextResponse.json({ success: true })
}
