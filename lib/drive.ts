import { google } from 'googleapis'
import { Readable } from 'stream'

/**
 * Google Drive API クライアント
 * 
 * OAuth方式:
 * - GOOGLE_CLIENT_ID
 * - GOOGLE_CLIENT_SECRET
 * - GOOGLE_DRIVE_REFRESH_TOKEN
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
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken.trim() })
    return google.drive({ version: 'v3', auth })
  }

  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) {
    throw new Error('Google Drive OAuth env vars are not set (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)')
  }

  const credentials = parseServiceAccountKey(keyString)
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })

  return google.drive({ version: 'v3', auth })
}

export async function uploadFileToDrive(fileBuffer: Buffer, fileName: string, mimeType: string, options?: { makePublic?: boolean }) {
  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set')
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
  if (response.data.id && options?.makePublic !== false) {
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

export async function downloadFileFromDrive(fileId: string) {
  const drive = getDriveClient()
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  )
  return Buffer.from(response.data as ArrayBuffer)
}

export async function deleteFileFromDrive(fileId: string) {
  const drive = getDriveClient()

  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  })
}

export async function extractTextFromPdfWithDriveOcr(fileBuffer: Buffer, fileName: string) {
  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()
  const stream = new Readable()
  stream.push(fileBuffer)
  stream.push(null)

  let temporaryDocumentId = ''
  try {
    const response = await drive.files.create({
      requestBody: {
        name: `${fileName.replace(/\.pdf$/i, '')}_OCR一時ファイル`,
        mimeType: 'application/vnd.google-apps.document',
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media: {
        mimeType: 'application/pdf',
        body: stream,
      },
      fields: 'id',
      ocrLanguage: 'ja',
      supportsAllDrives: true,
    })

    temporaryDocumentId = response.data.id || ''
    if (!temporaryDocumentId) throw new Error('Google Drive OCRの一時ファイルを作成できませんでした')

    const exported = await drive.files.export(
      { fileId: temporaryDocumentId, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' },
    )
    const text = Buffer.from(exported.data as ArrayBuffer).toString('utf8').trim()
    if (!text) throw new Error('Google Drive OCRの読取結果が空でした')
    return text
  } finally {
    if (temporaryDocumentId) {
      await drive.files.delete({ fileId: temporaryDocumentId, supportsAllDrives: true }).catch(() => {})
    }
  }
}
