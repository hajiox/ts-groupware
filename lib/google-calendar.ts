import { google } from 'googleapis'

const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const DEFAULT_CALENDAR_ID = 'aizubrandhall@gmail.com'

export type GoogleCalendarAuthInfo = {
  mode: 'oauth' | 'service_account'
  projectId: string | null
  serviceAccountEmail: string | null
}

function parseServiceAccountKey(keyString: string) {
  const trimmed = keyString.trim()
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  const jsonCandidate = objectStart >= 0 && objectEnd > objectStart
    ? trimmed.slice(objectStart, objectEnd + 1)
    : trimmed

  try {
    return JSON.parse(jsonCandidate)
  } catch (firstError) {
    const normalized = jsonCandidate.replace(
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

export function getGoogleCalendarId() {
  return process.env.GOOGLE_CALENDAR_ID?.trim() || DEFAULT_CALENDAR_ID
}

export function getGoogleCalendarAuthInfo(): GoogleCalendarAuthInfo {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    return {
      mode: 'oauth',
      projectId: null,
      serviceAccountEmail: null,
    }
  }

  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) {
    throw new Error('Google Calendar認証情報が未設定です')
  }

  const credentials = parseServiceAccountKey(keyString)
  return {
    mode: 'service_account',
    projectId: typeof credentials.project_id === 'string' ? credentials.project_id : null,
    serviceAccountEmail: typeof credentials.client_email === 'string' ? credentials.client_email : null,
  }
}

export function getGoogleCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken.trim() })
    return google.calendar({ version: 'v3', auth })
  }

  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyString) {
    throw new Error('Google Calendar認証情報が未設定です')
  }

  const credentials = parseServiceAccountKey(keyString)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
  })

  return google.calendar({ version: 'v3', auth })
}
