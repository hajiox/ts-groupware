// /app/api/upload/session/route.ts ver.1
import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { createDriveUploadSession } from '@/lib/drive'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name : ''
    const type = typeof body.type === 'string' ? body.type : 'application/octet-stream'
    const size = Number(body.size || 0)

    if (!name || !size) {
      return NextResponse.json({ error: 'ファイル名とサイズが必要です' }, { status: 400 })
    }

    if (size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'ファイルサイズは100MB以内にしてください' }, { status: 400 })
    }

    const session = await createDriveUploadSession(name, type, size)
    return NextResponse.json(session)
  } catch (err) {
    console.error('[Upload session] Error:', err)
    const message = err instanceof Error ? err.message : 'アップロード準備に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
