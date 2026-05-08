import { google } from 'googleapis'

/**
 * Google Drive API クライアント
 * 
 * サービスアカウントの JSON 文字列を環境変数 GOOGLE_SERVICE_ACCOUNT_KEY に設定。
 * ファイルのアップロード先フォルダ ID を GOOGLE_DRIVE_FOLDER_ID に設定。
 */

function getDriveClient() {
  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set')
  }

  const credentials = JSON.parse(keyString)
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })

  return google.drive({ version: 'v3', auth })
}

export async function uploadFileToDrive(fileBuffer: Buffer, fileName: string, mimeType: string) {
  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set')
  }

  // Node.js v18+ 組み込みの Readable.from を使わずに stream に変換
  const { Readable } = require('stream')
  const stream = new Readable()
  stream.push(fileBuffer)
  stream.push(null)

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id, webViewLink, webContentLink',
  })

  // 作成したファイルに「リンクを知っている全員が閲覧可」の権限を付与
  if (response.data.id) {
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    })
  }

  return response.data
}
