import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { uploadFileToDrive } from '@/lib/drive'

/**
 * POST /api/upload
 * 
 * FormData 経由でファイルを受け取り、Google Drive にアップロードして URL を返す。
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
      return NextResponse.json({ error: 'ファイルが見つかりません' }, { status: 400 })
    }

    // Bufferに変換
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    
    // ユニークなファイル名
    const timestamp = Date.now()
    const ext = file.name.split('.').pop()
    const fileName = `gw_${user.id}_${timestamp}.${ext}`

    // Driveにアップロード
    const uploadResult = await uploadFileToDrive(buffer, fileName, file.type)

    return NextResponse.json({
      url: uploadResult.webContentLink, // 直接ダウンロード用リンク
      viewUrl: uploadResult.webViewLink, // プレビュー用リンク
      name: file.name,
      type: file.type
    })

  } catch (err) {
    console.error('[Upload API] Error:', err)
    return NextResponse.json({ error: 'アップロードに失敗しました' }, { status: 500 })
  }
}
