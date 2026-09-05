import { calendar_v3 } from 'googleapis'
import { randomUUID } from 'node:crypto'
import {
  getGoogleCalendarAuthInfo,
  getGoogleCalendarClient,
  getGoogleCalendarId,
  type GoogleCalendarAuthInfo,
} from '@/lib/google-calendar'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'

const GOOGLE_CALENDAR_SOURCE = 'google_calendar'
const GOOGLE_EVENT_COLOR = '#0b8043'
const DEFAULT_TIME_ZONE = 'Asia/Tokyo'
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 10

type ImportedCalendarEvent = {
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  color: string
  source: string
  external_id: string
  source_updated_at: string | null
  created_by: string
  updated_at: string
}

type GoogleColorContext = {
  eventColors: Record<string, string>
  defaultColor: string
}

type SyncStatusRow = {
  sync_key: string
  last_synced_at: string | null
  last_attempted_at: string | null
  last_error: string | null
}

export type GoogleCalendarImportResult = {
  success: true
  calendar_id: string
  imported: number
  deleted: number
  colored: number
  skipped: number
  sync_skipped?: boolean
  sync_key?: string
  synced_at?: string
  sync_in_progress?: boolean
}

export type GoogleCalendarImportErrorPayload = {
  status: number
  error: string
  detail?: string
  calendar_id?: string
  auth_mode?: string | null
  google_project?: string | null
  service_account_email?: string | null
  enable_url?: string
}

export class GoogleCalendarImportFailure extends Error {
  payload: GoogleCalendarImportErrorPayload

  constructor(payload: GoogleCalendarImportErrorPayload) {
    super(payload.error)
    this.name = 'GoogleCalendarImportFailure'
    this.payload = payload
  }
}

function validDate(value: string) {
  const time = new Date(value).getTime()
  return Number.isFinite(time)
}

function cleanText(value: string | null | undefined, maxLength: number) {
  const text = (value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function googleDateToIso(date: string) {
  return new Date(`${date}T00:00:00+09:00`).toISOString()
}

function googleDateTimeToIso(value: string) {
  return new Date(value).toISOString()
}

function cleanHexColor(value: string | null | undefined) {
  const color = (value || '').trim()
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null
}

function colorDefinitionsToMap(definitions: calendar_v3.Schema$Colors['event'] | calendar_v3.Schema$Colors['calendar']) {
  return Object.fromEntries(
    Object.entries(definitions || {})
      .map(([id, definition]) => [id, cleanHexColor(definition?.background)])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  )
}

async function getGoogleColorContext(
  calendar: calendar_v3.Calendar,
  calendarId: string
): Promise<GoogleColorContext> {
  const colorsResponse = await calendar.colors.get({}, { timeout: 5000, retry: false })
  const eventColors = colorDefinitionsToMap(colorsResponse.data.event)
  const calendarColors = colorDefinitionsToMap(colorsResponse.data.calendar)
  let defaultColor = GOOGLE_EVENT_COLOR

  try {
    const calendarListEntry = await calendar.calendarList.get({ calendarId }, { timeout: 5000, retry: false })
    defaultColor = cleanHexColor(calendarListEntry.data.backgroundColor)
      || (calendarListEntry.data.colorId ? calendarColors[calendarListEntry.data.colorId] : null)
      || GOOGLE_EVENT_COLOR
  } catch {
    defaultColor = GOOGLE_EVENT_COLOR
  }

  return { eventColors, defaultColor }
}

function getGoogleEventColor(event: calendar_v3.Schema$Event, colors: GoogleColorContext) {
  return event.colorId ? colors.eventColors[event.colorId] || colors.defaultColor : colors.defaultColor
}

function normalizeGoogleEvent(
  event: calendar_v3.Schema$Event,
  calendarId: string,
  userId: string,
  colors: GoogleColorContext
): ImportedCalendarEvent | null {
  if (!event.id || event.status === 'cancelled') return null

  const allDay = Boolean(event.start?.date)
  const startValue = event.start?.date || event.start?.dateTime
  const endValue = event.end?.date || event.end?.dateTime
  if (!startValue || !endValue) return null

  const startsAt = allDay ? googleDateToIso(startValue) : googleDateTimeToIso(startValue)
  const endsAt = allDay ? googleDateToIso(endValue) : googleDateTimeToIso(endValue)
  if (!validDate(startsAt) || !validDate(endsAt) || new Date(endsAt) <= new Date(startsAt)) {
    return null
  }

  return {
    title: (event.summary || '無題の予定').trim().slice(0, 120) || '無題の予定',
    description: cleanText(event.description, 2000),
    location: cleanText(event.location, 240),
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: allDay,
    color: getGoogleEventColor(event, colors),
    source: GOOGLE_CALENDAR_SOURCE,
    external_id: `${calendarId}:${event.id}`,
    source_updated_at: event.updated || null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }
}

function isMissingExternalIdColumn(errorMessage: string) {
  return /external_id|source_updated_at|schema cache|PGRST204/i.test(errorMessage)
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function getDisabledCalendarApiProject(errorMessage: string) {
  const projectMatch = errorMessage.match(/project\s+([0-9A-Za-z_-]+)/i)
  const queryProjectMatch = errorMessage.match(/[?&]project=([0-9A-Za-z_-]+)/i)
  return queryProjectMatch?.[1] || projectMatch?.[1] || ''
}

function getCalendarApiEnableUrl(projectId: string) {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  return `https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview${query}`
}

function isCalendarApiDisabled(errorMessage: string) {
  return /Google Calendar API has not been used|calendar-json\.googleapis\.com|SERVICE_DISABLED|it is disabled/i.test(errorMessage)
}

function getGoogleApiStatus(error: unknown) {
  const apiError = error as { code?: number | string; response?: { status?: number } }
  const code = Number(apiError.code || apiError.response?.status)
  return Number.isFinite(code) ? code : null
}

function isCalendarNotFound(error: unknown, errorMessage: string) {
  return getGoogleApiStatus(error) === 404 || /^not found$/i.test(errorMessage.trim())
}

function getAutoSyncIntervalMs() {
  const minutes = Number(process.env.TSG_GOOGLE_CALENDAR_AUTO_SYNC_MINUTES || '')
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTO_SYNC_INTERVAL_MINUTES
  return safeMinutes * 60_000
}

function buildSyncKey(calendarId: string, rangeStart: string, rangeEnd: string) {
  const start = new Date(rangeStart).toISOString().slice(0, 10)
  const end = new Date(rangeEnd).toISOString().slice(0, 10)
  return `google_calendar:${calendarId}:${start}:${end}`
}

function isSyncStatusTableMissing(message: string) {
  return /gw_calendar_sync_status|relation .* does not exist|schema cache/i.test(message)
}

async function getRecentSync(syncKey: string) {
  const { data, error } = await adminClient
    .from('gw_calendar_sync_status')
    .select('sync_key, last_synced_at, last_attempted_at, last_error')
    .eq('sync_key', syncKey)
    .maybeSingle()

  if (error) {
    const message = getErrorMessage(error, '')
    if (isSyncStatusTableMissing(message)) return null
    throw error
  }

  return data as SyncStatusRow | null
}

async function writeSyncStatus(values: {
  syncKey: string
  calendarId: string
  rangeStart: string
  rangeEnd: string
  lastAttemptedAt?: string
  lastSyncedAt?: string | null
  lastError?: string | null
  lastImported?: number
  lastDeleted?: number
  lastColored?: number
}) {
  const payload = {
    sync_key: values.syncKey,
    calendar_id: values.calendarId,
    range_start: values.rangeStart,
    range_end: values.rangeEnd,
    last_attempted_at: values.lastAttemptedAt || new Date().toISOString(),
    last_synced_at: values.lastSyncedAt,
    last_error: values.lastError ?? null,
    last_imported: values.lastImported ?? 0,
    last_deleted: values.lastDeleted ?? 0,
    last_colored: values.lastColored ?? 0,
    updated_at: new Date().toISOString(),
  }

  const { error } = await adminClient
    .from('gw_calendar_sync_status')
    .upsert(payload, { onConflict: 'sync_key' })

  if (error) {
    const message = getErrorMessage(error, '')
    if (isSyncStatusTableMissing(message)) return
    throw error
  }
}

async function getCalendarImportUserId(fallbackUserId: string) {
  const configured = process.env.TSG_CALENDAR_IMPORT_USER_ID?.trim()
  if (configured) return configured

  const tsgUserId = await getTsgUserId().catch(() => null)
  if (tsgUserId) return tsgUserId

  const { data } = await adminClient
    .from('gw_users')
    .select('id')
    .in('role', ['executive', 'admin'])
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return data?.id || fallbackUserId
}

export function isAutoGoogleCalendarSyncEnabled() {
  const value = process.env.TSG_GOOGLE_CALENDAR_AUTO_SYNC?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'off'
}

export function buildGoogleCalendarImportErrorPayload(
  error: unknown,
  authInfo: GoogleCalendarAuthInfo | null,
  calendarId = getGoogleCalendarId()
): GoogleCalendarImportErrorPayload {
  if (error instanceof GoogleCalendarImportFailure) return error.payload

  const message = getErrorMessage(error, 'Googleカレンダー取込に失敗しました')
  if (isCalendarApiDisabled(message)) {
    const googleProject = getDisabledCalendarApiProject(message) || authInfo?.projectId || ''
    return {
      status: 502,
      error: 'Google Calendar APIがGoogle Cloud側で未有効です。対象カレンダーとCloudプロジェクトを確認し、Calendar APIを有効化してから再度取り込んでください。',
      detail: message,
      calendar_id: calendarId,
      google_project: googleProject || null,
      enable_url: getCalendarApiEnableUrl(googleProject),
    }
  }

  if (isCalendarNotFound(error, message)) {
    const isServiceAccount = authInfo?.mode === 'service_account'
    return {
      status: 404,
      error: isServiceAccount
        ? 'Googleカレンダーが見つからないか、TSGのサービスアカウントに共有されていません。対象カレンダーの「特定のユーザーとの共有」に下記の認証アカウントを追加してください。'
        : 'Googleカレンダーが見つからないか、認証中のGoogleアカウントから閲覧できません。対象カレンダーIDとOAuth認証アカウントを確認してください。',
      detail: message,
      calendar_id: calendarId,
      auth_mode: authInfo?.mode || null,
      google_project: authInfo?.projectId || null,
      service_account_email: authInfo?.serviceAccountEmail || null,
    }
  }

  if (isMissingExternalIdColumn(message)) {
    return {
      status: 500,
      error: 'Googleカレンダー取込用のDBマイグレーションが未適用です',
      detail: message,
    }
  }

  return {
    status: 500,
    error: message,
    detail: message,
  }
}

export function errorPayloadBody(payload: GoogleCalendarImportErrorPayload) {
  return {
    error: payload.error,
    detail: payload.detail,
    calendar_id: payload.calendar_id,
    auth_mode: payload.auth_mode,
    google_project: payload.google_project,
    service_account_email: payload.service_account_email,
    enable_url: payload.enable_url,
  }
}

export async function syncGoogleCalendarRange(options: {
  rangeStart: string
  rangeEnd: string
  requestedBy: string
  force?: boolean
}): Promise<GoogleCalendarImportResult> {
  const { rangeStart, rangeEnd, requestedBy, force = false } = options

  if (!validDate(rangeStart) || !validDate(rangeEnd) || new Date(rangeEnd) <= new Date(rangeStart)) {
    throw new GoogleCalendarImportFailure({
      status: 400,
      error: '取込期間を確認してください',
    })
  }

  const calendarId = getGoogleCalendarId()
  const syncKey = buildSyncKey(calendarId, rangeStart, rangeEnd)
  const now = new Date()
  const nowIso = now.toISOString()

  if (!force) {
    const recentSync = await getRecentSync(syncKey)
    const lastSyncedAt = recentSync?.last_synced_at ? new Date(recentSync.last_synced_at).getTime() : 0
    if (recentSync?.last_error && now.getTime() - Date.parse(recentSync.last_attempted_at || '') < 60_000) {
      throw new GoogleCalendarImportFailure({ status: 503, error: recentSync.last_error })
    }
    if (!recentSync?.last_error && lastSyncedAt && now.getTime() - lastSyncedAt < getAutoSyncIntervalMs()) {
      return {
        success: true,
        calendar_id: calendarId,
        imported: 0,
        deleted: 0,
        colored: 0,
        skipped: 0,
        sync_skipped: true,
        sync_key: syncKey,
        synced_at: recentSync?.last_synced_at || undefined,
      }
    }
  }

  const leaseToken = randomUUID()
  const lease = await adminClient.rpc('gw_claim_calendar_sync', { p_calendar_id: calendarId, p_token: leaseToken })
  if (lease.error) throw new GoogleCalendarImportFailure({ status: 503, error: 'カレンダー同期の準備が完了していません' })
  if (!lease.data) return { success: true, calendar_id: calendarId, imported: 0, deleted: 0, colored: 0, skipped: 0, sync_in_progress: true }

  let authInfo: GoogleCalendarAuthInfo | null = null
  try {
    await writeSyncStatus({
      syncKey,
      calendarId,
      rangeStart,
      rangeEnd,
      lastAttemptedAt: nowIso,
      lastError: null,
    })
    authInfo = getGoogleCalendarAuthInfo()
    const calendar = getGoogleCalendarClient()
    const colorContext = await getGoogleColorContext(calendar, calendarId).catch(() => ({ eventColors: {}, defaultColor: GOOGLE_EVENT_COLOR } as GoogleColorContext))
    const importerUserId = await getCalendarImportUserId(requestedBy)
    const googleEvents: calendar_v3.Schema$Event[] = []
    let pageToken: string | undefined
    const fetchStarted = Date.now()
    do {
      if (Date.now() - fetchStarted > 45_000 || googleEvents.length > 25_000) throw new Error('カレンダーの取得に時間がかかっています。保存済みの予定を保持して次回再試行します')
      const response = await calendar.events.list({
        calendarId,
        timeMin: new Date(rangeStart).toISOString(),
        timeMax: new Date(rangeEnd).toISOString(),
        maxResults: 2500,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true,
        timeZone: DEFAULT_TIME_ZONE,
        pageToken,
      }, { timeout: 8000, retry: true, retryConfig: { retry: 2, noResponseRetries: 1, retryDelay: 500, statusCodesToRetry: [[429, 429], [500, 599]] } })
      googleEvents.push(...(response.data.items || []))
      pageToken = response.data.nextPageToken || undefined
    } while (pageToken)

    const cancelledExternalIds = googleEvents
      .filter(event => event.status === 'cancelled' && event.id)
      .map(event => `${calendarId}:${event.id}`)
    const rows = googleEvents
      .map(event => normalizeGoogleEvent(event, calendarId, importerUserId, colorContext))
      .filter((event): event is ImportedCalendarEvent => Boolean(event))
    const colored = googleEvents.filter(event => event.colorId && colorContext.eventColors[event.colorId]).length
    if (rows.length + cancelledExternalIds.length !== googleEvents.length) throw new Error('カレンダー予定の日時を確認できないため、保存済みの予定を保持しました')
    const snapshot = await adminClient.rpc('gw_replace_google_calendar_range', {
      p_calendar_id: calendarId, p_token: leaseToken,
      p_start: rangeStart, p_end: rangeEnd, p_events: rows,
    })
    if (snapshot.error) throw snapshot.error
    const deleted = Number(snapshot.data || 0)
    const imported = rows.length

    const result: GoogleCalendarImportResult = {
      success: true,
      calendar_id: calendarId,
      imported,
      deleted,
      colored,
      skipped: Math.max(0, googleEvents.length - rows.length - cancelledExternalIds.length),
      sync_key: syncKey,
      synced_at: new Date().toISOString(),
    }

    await writeSyncStatus({
      syncKey,
      calendarId,
      rangeStart,
      rangeEnd,
      lastAttemptedAt: nowIso,
      lastSyncedAt: result.synced_at,
      lastError: null,
      lastImported: imported,
      lastDeleted: deleted,
      lastColored: colored,
    })

    return result
  } catch (error) {
    const payload = buildGoogleCalendarImportErrorPayload(error, authInfo, calendarId)
    await writeSyncStatus({
      syncKey,
      calendarId,
      rangeStart,
      rangeEnd,
      lastAttemptedAt: nowIso,
      lastError: payload.error,
    }).catch(() => undefined)
    throw new GoogleCalendarImportFailure(payload)
  } finally {
    await adminClient.from('gw_calendar_sync_leases').delete().eq('calendar_id', calendarId).eq('token', leaseToken)
  }
}
