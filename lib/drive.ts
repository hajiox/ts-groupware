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

// Payroll archives never inherit the ordinary attachment folder's sharing.
// A dedicated My Drive folder may be owned by one account and shared only
// with this API's authenticated account (for service-account access).
export class PayrollArchiveStorageError extends Error {
  constructor(readonly code: string) { super(code) }
}
function payrollStorageFailure(error:unknown, fallback:string) {
  if(error instanceof PayrollArchiveStorageError) return error
  const status=error&&typeof error==='object'&&'code' in error?Number(error.code):0
  return new PayrollArchiveStorageError(status===401?'archive_auth_unavailable':status===403?'archive_access_denied':status===404?'archive_folder_not_accessible':fallback)
}
async function payrollArchiveStore(explicitFolderId?:string, ownerOnly=false) {
  let drive:ReturnType<typeof getDriveClient>
  try {drive=getDriveClient()} catch {throw new PayrollArchiveStorageError('archive_auth_not_configured')}
  const folderId = explicitFolderId || process.env.GOOGLE_PAYROLL_FOLDER_ID?.trim()
  if (!folderId) throw new PayrollArchiveStorageError('archive_folder_not_configured')
  const account = await drive.about.get({ fields: 'user(emailAddress)' }).catch(error=>{throw payrollStorageFailure(error,'archive_account_unavailable')})
  const actor = account.data.user?.emailAddress?.toLowerCase()
  if (!actor) throw new PayrollArchiveStorageError('archive_account_unavailable')
  const validatePermissions = async (fileId: string) => {
    const permissions = await drive.permissions.list({ fileId, fields: 'nextPageToken,permissions(type,role,emailAddress,deleted)', pageSize: 100, supportsAllDrives: true })
      .catch(error=>{throw payrollStorageFailure(error,'archive_permissions_unavailable')})
    const rows = permissions.data.permissions || []
    if (permissions.data.nextPageToken || !rows.some(permission => !permission.deleted && permission.type === 'user' && permission.role === 'owner') || rows.some(permission => (
      !permission.deleted && (permission.type !== 'user' || (permission.role !== 'owner' && permission.emailAddress?.toLowerCase() !== actor))
    ))) throw new PayrollArchiveStorageError('archive_folder_not_private')
    if(ownerOnly&&rows.some(permission=>!permission.deleted&&(permission.role!=='owner'||permission.emailAddress?.toLowerCase()!==actor))) {
      throw new PayrollArchiveStorageError('archive_folder_not_private')
    }
  }
  const folder = await drive.files.get({ fileId: folderId, fields: 'mimeType,trashed,driveId,capabilities(canAddChildren)', supportsAllDrives: true })
    .catch(error=>{throw payrollStorageFailure(error,'archive_folder_unavailable')})
  if (folder.data.mimeType !== 'application/vnd.google-apps.folder' || folder.data.trashed || folder.data.driveId) throw new PayrollArchiveStorageError('archive_folder_not_private')
  if(folder.data.capabilities?.canAddChildren !== true) throw new PayrollArchiveStorageError('archive_folder_not_writable')
  await validatePermissions(folderId)
  return { drive, folderId, validatePermissions }
}

export async function checkPayrollArchiveStorage() {
  await payrollArchiveStore()
  return true
}

// Explicit setup only. Neither readiness nor normal intake creates folders.
// Creating through this OAuth client also makes the folder visible under its
// existing drive.file grant; a folder created by another app may be invisible.
export async function initializePayrollArchiveStorage() {
  try {
    const drive=getDriveClient()
    const found=await drive.files.list({
      q:"trashed = false and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and appProperties has { key='tsgPurpose' and value='payroll-mail-private-v1' }",
      fields:'nextPageToken,files(id)',pageSize:100,spaces:'drive',corpora:'user',orderBy:'createdTime',
    })
    const folders=found.data.files||[]
    if(found.data.nextPageToken||folders.length>1) throw new PayrollArchiveStorageError('archive_setup_ambiguous')
    let folderId=folders[0]?.id
    if(!folderId) {
      const created=await drive.files.create({
        requestBody:{name:'TSG 給与原本（非公開）',mimeType:'application/vnd.google-apps.folder',parents:['root'],
          appProperties:{tsgPurpose:'payroll-mail-private-v1'}},fields:'id',
      })
      folderId=created.data.id
    }
    if(!folderId) throw new PayrollArchiveStorageError('archive_setup_failed')
    await payrollArchiveStore(folderId,true)
    return {folderId}
  } catch(error) {throw payrollStorageFailure(error,'archive_setup_failed')}
}

export async function uploadPayrollArchiveToDrive(fileBuffer: Buffer, fileName: string) {
  const { drive, folderId, validatePermissions } = await payrollArchiveStore()
  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: 'application/zip', body: Readable.from(fileBuffer) },
    fields: 'id', supportsAllDrives: true,
  })
  if (!response.data.id) throw new Error('Payroll archive could not be saved')
  try { await validatePermissions(response.data.id) }
  catch (error) {
    await drive.files.update({ fileId: response.data.id, requestBody: { trashed: true }, supportsAllDrives: true }).catch(() => undefined)
    throw error
  }
  return { id: response.data.id }
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
