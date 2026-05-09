import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

/**
 * POST /api/upload — ファイルアップロード（Supabase Storage）
 *
 * FormData で受け取ったファイルを Supabase Storage の gw-files バケットに保存し、
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

    // ユニークなファイル名を生成
    const ext = file.name.split('.').pop() || 'bin'
    const timestamp = Date.now()
    const filePath = `${user.id}/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`

    // File を ArrayBuffer に変換して Upload
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const { error: uploadError } = await adminClient.storage
      .from('gw-files')
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error('[Upload] Supabase Storage error:', uploadError)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    // 公開URLを取得
    const { data: urlData } = adminClient.storage
      .from('gw-files')
      .getPublicUrl(filePath)

    return NextResponse.json({
      url: urlData.publicUrl,
      name: file.name,
      type: file.type,
    })
  } catch (err) {
    console.error('[Upload] Unexpected error:', err)
    return NextResponse.json({ error: 'アップロードに失敗しました' }, { status: 500 })
  }
}
