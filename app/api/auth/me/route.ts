import { NextResponse } from 'next/server'
import { canUserApplyForBereavementLeave } from '@/lib/bereavement-leave-data'
import { canReceivePaidLeaveApprovals } from '@/lib/paid-leave-approval'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'

/**
 * GET /api/auth/me
 *
 * 現在ログイン中のユーザー情報を返す。
 * クライアントコンポーネントから fetch して認証状態を確認する。
 */
export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  const permissions = getManagementPermissions(user)
  const canApprovePaidLeave = canReceivePaidLeaveApprovals(user)
  let canUseBereavementLeave = permissions.canManageAttendance
  if (!canUseBereavementLeave) {
    try {
      canUseBereavementLeave = await canUserApplyForBereavementLeave(user.id)
    } catch (error) {
      console.error('[Bereavement permission error]', error)
    }
  }
  return NextResponse.json(
    {
      user,
      permissions: {
        ...permissions,
        canApprovePaidLeave,
        canUseBereavementLeave,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
