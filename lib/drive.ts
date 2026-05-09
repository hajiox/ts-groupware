import { google } from 'googleapis'
import { Readable } from 'stream'

/**
 * Google Drive API クライアント
 * 
 * サービスアカウントの JSON 文字列を環境変数 GOOGLE_SERVICE_ACCOUNT_KEY に設定。
 * ファイルのアップロード先フォルダ ID を GOOGLE_DRIVE_FOLDER_ID に設定。
 */

function parseServiceAccountKey(keyString: string) {
  try {
    return JSON.parse(keyString)
  } catch (firstError) {
    const normalized = keyString.replace(
      /("private_key"\s*:\s*")([\s\S]*?)("\s*,\s*"client_email")/,
      (_match, prefix: string, privateKey: string, suffix: string) => {
        const fixedPrivateKey = privateKey
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\n/g, '\\n')

        return `${prefix}${fixedPrivateKey}${suffix}`
      }
    )

    try {
      return JSON.parse(normalized)
    } catch {
      const message = firstError instanceof Error ? firstError.message : 'invalid JSON'
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY is invalid JSON: ${message}`)
    }
  }
}

function getDriveClient() {
  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set')
  }

  const credentials = parseServiceAccountKey(keyString)
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })

  return google.drive({ version: 'v3', auth })
}

export async function uploadFileToDrive(fileBuffer: Buffer, fileName: string, mimeType: string) {
  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set. Service accounts cannot upload to their own My Drive; set a shared drive folder ID.')
  }

  // Node.js 組み込みの Readable で Buffer を stream に変換
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
    supportsAllDrives: true,
  })

  // 作成したファイルに「リンクを知っている全員が閲覧可」の権限を付与
  if (response.data.id) {
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    })
  }

  return response.data
}
