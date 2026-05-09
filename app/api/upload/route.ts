import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { uploadFileToDrive } from '@/lib/drive'

/**
 * POST /api/upload — ファイルアップロード（Google Drive）
 *
 * FormData で受け取ったファイルを Google Drive にアップロードし、
 * 公開URLを返す。
 */

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'ファイルが必要です' }, { status: 400 })
    }

    // ファイルサイズ制限 (10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'ファイルサイズは10MB以内にしてください' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const driveFile = await uploadFileToDrive(buffer, file.name, file.type)

    const fileUrl = driveFile.id
      ? `https://drive.google.com/uc?export=download&id=${driveFile.id}`
      : driveFile.webViewLink || ''
    const thumbnailUrl = driveFile.id
      ? `https://drive.google.com/thumbnail?id=${driveFile.id}&sz=w1200`
      : fileUrl

    return NextResponse.json({
      url: fileUrl,
      viewUrl: file.type.startsWith('image/') ? thumbnailUrl : fileUrl,
      name: file.name,
      type: file.type,
      driveId: driveFile.id,
      webViewLink: driveFile.webViewLink,
    })
  } catch (err) {
    console.error('[Upload] Error:', err)
    const message = err instanceof Error ? err.message : 'アップロードに失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
