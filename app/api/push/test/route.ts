import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { sendPushNotificationToUserWithResult } from '@/lib/web-push'

export async function POST() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const result = await sendPushNotificationToUserWithResult(user.id, {
    title: 'TS Groupware',
    body: 'テスト通知です。この通知が表示されたか確認してください。',
    url: '/settings',
    tag: `tsg-test-${user.id}`,
  })

  if (!result.accepted) return NextResponse.json({error:result.outcome==='no_subscription'?'通知端末が未登録です':'通知サービスへの送信に失敗しました',result},{status:503})
  return NextResponse.json({ success:true,result })
}
