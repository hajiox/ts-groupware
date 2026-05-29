// /app/api/upload/complete/route.ts ver.1
import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { makeDriveFilePublic } from '@/lib/drive'

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const fileId = typeof body.fileId === 'string' ? body.fileId : ''
    const name = typeof body.name === 'string' ? body.name : 'file'
    const type = typeof body.type === 'string' ? body.type : 'application/octet-stream'

    if (!fileId) {
      return NextResponse.json({ error: 'fileId が必要です' }, { status: 400 })
    }

    const driveFile = await makeDriveFilePublic(fileId)
    const fileUrl = `https://drive.google.com/uc?export=download&id=${fileId}`
    const thumbnailUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`

    return NextResponse.json({
      url: fileUrl,
      viewUrl: type.startsWith('image/') ? thumbnailUrl : fileUrl,
      name,
      type,
      driveId: fileId,
      webViewLink: driveFile.webViewLink,
    })
  } catch (err) {
    console.error('[Upload complete] Error:', err)
    const message = err instanceof Error ? err.message : 'アップロード完了処理に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
