// /lib/upload-client.ts ver.1
const DIRECT_DRIVE_UPLOAD_THRESHOLD = 4 * 1024 * 1024
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export type UploadedAttachment = {
  url: string
  viewUrl?: string
  name: string
  type: string
  driveId?: string
  webViewLink?: string
}

async function uploadViaAppRoute(file: File): Promise<UploadedAttachment> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  })
  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw new Error(data.error || 'ファイルのアップロードに失敗しました')
  }

  return data
}

async function uploadDirectlyToDrive(file: File): Promise<UploadedAttachment> {
  const sessionRes = await fetch('/api/upload/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
    }),
  })
  const session = await sessionRes.json().catch(() => ({}))

  if (!sessionRes.ok || !session.uploadUrl) {
    throw new Error(session.error || 'アップロード準備に失敗しました')
  }

  const uploadRes = await fetch(session.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  const uploaded = await uploadRes.json().catch(() => ({}))

  if (!uploadRes.ok || !uploaded.id) {
    throw new Error(uploaded.error?.message || 'Google Driveへのアップロードに失敗しました')
  }

  const completeRes = await fetch('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: uploaded.id,
      name: file.name,
      type: file.type || 'application/octet-stream',
    }),
  })
  const completed = await completeRes.json().catch(() => ({}))

  if (!completeRes.ok) {
    throw new Error(completed.error || 'アップロード完了処理に失敗しました')
  }

  return completed
}

export async function uploadAttachmentFile(file: File): Promise<UploadedAttachment> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('ファイルサイズは100MB以内にしてください')
  }

  if (file.size > DIRECT_DRIVE_UPLOAD_THRESHOLD) {
    return uploadDirectlyToDrive(file)
  }

  return uploadViaAppRoute(file)
}
