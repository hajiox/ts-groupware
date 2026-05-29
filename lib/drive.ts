// /lib/drive.ts ver.2
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

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken.trim() })
    return auth
  }

  return null
}

function getGoogleAuth() {
  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) return null

  const credentials = parseServiceAccountKey(keyString)

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })
}

function getDriveClient() {
  const oauthClient = getOAuthClient()
  if (oauthClient) {
    return google.drive({ version: 'v3', auth: oauthClient })
  }

  const googleAuth = getGoogleAuth()
  if (!googleAuth) {
    throw new Error('Google Drive OAuth env vars are not set (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)')
  }

  return google.drive({ version: 'v3', auth: googleAuth })
}

async function getAccessToken() {
  const oauthClient = getOAuthClient()
  if (oauthClient) {
    const tokenResponse = await oauthClient.getAccessToken()
    const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token
    if (!token) throw new Error('Google Drive OAuth access token could not be created')
    return token
  }

  const googleAuth = getGoogleAuth()
  if (!googleAuth) {
    throw new Error('Google Drive OAuth env vars are not set (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)')
  }

  const authClient = await googleAuth.getClient()
  const tokenResponse = await authClient.getAccessToken()
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token
  if (!token) throw new Error('Google Drive service account access token could not be created')
  return token
}

export async function uploadFileToDrive(fileBuffer: Buffer, fileName: string, mimeType: string) {
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

export async function createDriveUploadSession(fileName: string, mimeType: string, fileSize: number) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set')
  }

  const token = await getAccessToken()
  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink,webContentLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
      }),
    }
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Google Drive upload session failed: ${response.status} ${errorText}`)
  }

  const uploadUrl = response.headers.get('location')
  if (!uploadUrl) {
    throw new Error('Google Drive upload session URL was not returned')
  }

  return { uploadUrl }
}

export async function makeDriveFilePublic(fileId: string) {
  const drive = getDriveClient()

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,
  })

  const response = await drive.files.get({
    fileId,
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
  })

  return response.data
}

export async function deleteFileFromDrive(fileId: string) {
  const drive = getDriveClient()

  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  })
}
