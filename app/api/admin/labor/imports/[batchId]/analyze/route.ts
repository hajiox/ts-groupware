import { NextResponse } from 'next/server'
import { analyzeLaborImportBatch } from '@/lib/labor-payroll-zip'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  if (!getManagementPermissions(user).canViewPayroll) {
    return NextResponse.json({ error: '給与データの解析権限がありません' }, { status: 403 })
  }

  try {
    const { batchId } = await context.params
    const result = await analyzeLaborImportBatch(batchId)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '労務ZIPの解析に失敗しました',
    }, { status: 500 })
  }
}
