import { NextRequest, NextResponse } from 'next/server'
import {
  GoogleCalendarImportFailure,
  buildGoogleCalendarImportErrorPayload,
  errorPayloadBody,
  syncGoogleCalendarRange,
} from '@/lib/google-calendar-import'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'

function getErrorResponse(error: unknown) {
  const payload = error instanceof GoogleCalendarImportFailure
    ? error.payload
    : buildGoogleCalendarImportErrorPayload(error, null)

  return NextResponse.json(errorPayloadBody(payload), { status: payload.status })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUserSession()
    if (!user) {
      return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
    }
    if (!isManagementUser(user)) {
      return NextResponse.json({ error: 'Googleカレンダー取込は役員または管理者のみ実行できます' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const rangeStart = typeof body.range_start === 'string' ? body.range_start : ''
    const rangeEnd = typeof body.range_end === 'string' ? body.range_end : ''

    const result = await syncGoogleCalendarRange({
      rangeStart,
      rangeEnd,
      requestedBy: user.id,
      force: true,
    })

    return NextResponse.json(result)
  } catch (error) {
    const response = getErrorResponse(error)
    if (!(error instanceof GoogleCalendarImportFailure)) {
      console.error('[calendar/import/google] unhandled error', error)
    }
    return response
  }
}
