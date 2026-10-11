import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { uploadFileToDrive, deleteFileFromDrive } from '@/lib/drive'
import { adminClient } from '@/lib/supabase/admin'
import { getBusinessContext } from '@/lib/business-api/context'

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

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

    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'ファイルサイズは4MB以内にしてください' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const driveFile = await uploadFileToDrive(buffer, file.name, file.type)

    const context = getBusinessContext()
    if (context) {
      if (!driveFile.id) throw new Error('アップロードしたファイルを識別できませんでした')
      const { error } = await adminClient.from('gw_data_business_uploads').insert({
        connection_id: context.connectionId,
        drive_id: driveFile.id,
      })
      if (error) {
        // Never return an untracked file that can bypass the connection boundary.
        await deleteFileFromDrive(driveFile.id).catch(() => undefined)
        throw new Error('添付ファイルの所有権を保存できませんでした')
      }
    }

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
