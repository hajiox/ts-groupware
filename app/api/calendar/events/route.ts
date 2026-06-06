import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

const EVENT_COLORS = new Set([
  '#1a73e8',
  '#0b8043',
  '#f4511e',
  '#8e24aa',
  '#d93025',
  '#fbbc04',
  '#00897b',
])

type CalendarEventRow = {
  id: string
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  color: string
  source: string
  created_by: string
  created_at: string
  updated_at: string | null
}

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
}

function displayName(user?: UserRow | null) {
  return user?.real_name || user?.display_name || '不明'
}

function validDate(value: string) {
  const time = new Date(value).getTime()
  return Number.isFinite(time)
}

function cleanString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function cleanOptionalString(value: unknown, maxLength: number) {
  const text = cleanString(value, maxLength)
  return text || null
}

function cleanColor(value: unknown) {
  if (typeof value !== 'string') return '#1a73e8'
  return EVENT_COLORS.has(value) ? value : '#1a73e8'
}

async function enrichEvents(events: CalendarEventRow[]) {
  if (events.length === 0) return []

  const userIds = [...new Set(events.map(event => event.created_by))]
  const { data: users } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url')
    .in('id', userIds)

  const userMap = Object.fromEntries(((users || []) as UserRow[]).map(user => [
    user.id,
    { ...user, display_name: displayName(user) },
  ]))

  return events.map(event => ({
    ...event,
    creator: userMap[event.created_by] || null,
  }))
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const rangeStart = request.nextUrl.searchParams.get('range_start') || ''
  const rangeEnd = request.nextUrl.searchParams.get('range_end') || ''

  if (!validDate(rangeStart) || !validDate(rangeEnd)) {
    return NextResponse.json({ error: 'range_start と range_end が必要です' }, { status: 400 })
  }

  const { data, error } = await adminClient
    .from('gw_calendar_events')
    .select('*')
    .lt('starts_at', rangeEnd)
    .gt('ends_at', rangeStart)
    .order('starts_at', { ascending: true })
    .limit(500)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ events: await enrichEvents((data || []) as CalendarEventRow[]) })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const title = cleanString(body.title, 120)
  const startsAt = cleanString(body.starts_at, 80)
  const endsAt = cleanString(body.ends_at, 80)

  if (!title) {
    return NextResponse.json({ error: 'タイトルを入力してください' }, { status: 400 })
  }
  if (!validDate(startsAt) || !validDate(endsAt) || new Date(endsAt) <= new Date(startsAt)) {
    return NextResponse.json({ error: '日時を確認してください' }, { status: 400 })
  }

  const { data, error } = await adminClient
    .from('gw_calendar_events')
    .insert({
      title,
      description: cleanOptionalString(body.description, 2000),
      location: cleanOptionalString(body.location, 240),
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: Boolean(body.all_day),
      color: cleanColor(body.color),
      source: 'manual',
      created_by: user.id,
    })
    .select('*')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || '予定の作成に失敗しました' }, { status: 500 })
  }

  return NextResponse.json({ event: (await enrichEvents([data as CalendarEventRow]))[0] })
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const eventId = cleanString(body.id, 80)
  const title = cleanString(body.title, 120)
  const startsAt = cleanString(body.starts_at, 80)
  const endsAt = cleanString(body.ends_at, 80)

  if (!eventId) {
    return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  }
  if (!title) {
    return NextResponse.json({ error: 'タイトルを入力してください' }, { status: 400 })
  }
  if (!validDate(startsAt) || !validDate(endsAt) || new Date(endsAt) <= new Date(startsAt)) {
    return NextResponse.json({ error: '日時を確認してください' }, { status: 400 })
  }

  const { data: existing } = await adminClient
    .from('gw_calendar_events')
    .select('id, created_by')
    .eq('id', eventId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: '予定が見つかりません' }, { status: 404 })
  }
  if (existing.created_by !== user.id && user.role !== 'admin') {
    return NextResponse.json({ error: 'この予定を編集できません' }, { status: 403 })
  }

  const { data, error } = await adminClient
    .from('gw_calendar_events')
    .update({
      title,
      description: cleanOptionalString(body.description, 2000),
      location: cleanOptionalString(body.location, 240),
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: Boolean(body.all_day),
      color: cleanColor(body.color),
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventId)
    .select('*')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || '予定の更新に失敗しました' }, { status: 500 })
  }

  return NextResponse.json({ event: (await enrichEvents([data as CalendarEventRow]))[0] })
}

export async function DELETE(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const eventId = request.nextUrl.searchParams.get('id') || ''
  if (!eventId) {
    return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  }

  const { data: existing } = await adminClient
    .from('gw_calendar_events')
    .select('id, created_by')
    .eq('id', eventId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: '予定が見つかりません' }, { status: 404 })
  }
  if (existing.created_by !== user.id && user.role !== 'admin') {
    return NextResponse.json({ error: 'この予定を削除できません' }, { status: 403 })
  }

  const { error } = await adminClient
    .from('gw_calendar_events')
    .delete()
    .eq('id', eventId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
