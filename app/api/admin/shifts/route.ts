import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, isUserDepartment, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { isAutoGoogleCalendarSyncEnabled, syncGoogleCalendarRange } from '@/lib/google-calendar-import'
import { syncFloorShiftSales } from '@/lib/shift-calendar-sales-sync'
import { getManagementPermissions } from '@/lib/management-permissions'
import { syncShiftPaidLeaveRequests } from '@/lib/paid-leave-data'
import { getUserSession } from '@/lib/session'
import { SHIFT_COMPANY_OFF_NOTE, countsTowardDepartmentHeadcount, isCompanyOffAssignment } from '@/lib/shift-assignments'
import { resolveShiftConstraints, shiftWorkStyleLabel, type ShiftConstraints } from '@/lib/shift-constraints'
import { isShiftRequestCollectionExcluded, isShiftRosterExcluded } from '@/lib/shift-request-exclusions'
import { normalizeShiftEcSaleIds, normalizeShiftEcSaleTimes, type ShiftEcSaleColor, type ShiftEcSaleOption, type ShiftEcSaleTimes } from '@/lib/shift-sales'
import { shiftTimeeHeadcount } from '@/lib/shift-timee'
import { adminClient } from '@/lib/supabase/admin'

type ShiftStatus = 'draft' | 'collecting' | 'generated' | 'editing' | 'confirmed' | 'exported' | 'archived'
type ShiftRequestType = 'day_off' | 'unavailable' | 'paid_leave_full' | 'paid_leave_half' | 'available' | 'time_preference' | 'note'

type ShiftPeriod = {
  id: string
  department: UserDepartment
  title: string
  start_date: string
  end_date: string
  request_deadline: string | null
  status: ShiftStatus
  notes: string | null
  is_test_mode: boolean
}

type ShiftPattern = {
  id: string
  department: UserDepartment
  label: string
  start_time: string | null
  end_time: string | null
  break_minutes: number
  work_minutes: number | null
  pattern_role: ShiftPatternRole
  sort_order: number
  is_active: boolean
}

type ShiftPatternRole = 'standard' | 'basic_work' | 'floor_work'

type ShiftPatternPreference = {
  id: string
  department: UserDepartment
  employee_id: string | null
  user_id: string | null
  employee_code: string | null
  employee_name: string | null
  pattern_label: string
  weight: number
  sort_order: number
}

type ShiftEmployee = {
  id: string
  user_id: string
  employee_code: string | null
  display_name: string
  real_name: string | null
  hire_date: string | null
  department: UserDepartment
  work_style: string | null
  payroll_status: string
  basic_work_start: string | null
  basic_work_end: string | null
  basic_break_minutes: number | null
  shift_sort_order: number | null
  request_collection_excluded: boolean
}

type ShiftRequirement = {
  id?: string
  period_id: string
  work_date: string
  required_count: number | string | null
  workplace_label: string | null
  notes: string | null
  notes2: string | null
  notes3: string | null
  production_plan: string | null
  timee_count: number | string | null
  ec_sale_tags: string[]
  ec_sale_times: ShiftEcSaleTimes
}

type ShiftRequestRow = {
  id: string
  period_id: string
  user_id: string
  employee_id: string | null
  work_date: string
  request_type: ShiftRequestType
  priority: 'must' | 'prefer' | 'ok'
  start_time: string | null
  end_time: string | null
  memo: string | null
  is_test: boolean
}

type ShiftRequestSubmission = {
  id: string
  period_id: string
  user_id: string
  employee_id: string | null
  submitted_at: string
  request_comment: string | null
  max_work_days: number | null
  target_work_days: number | null
  min_days_off: number | null
  max_consecutive_days: number | null
  is_test: boolean
}

type ShiftRequestTarget = {
  id: string
  period_id: string
  user_id: string
  employee_id: string | null
  requested_at: string
}

type ShiftPeriodExclusion = {
  id: string
  period_id: string
  user_id: string
  employee_id: string | null
  excluded_at: string
}

type ShiftAssignment = {
  id: string
  period_id: string
  user_id: string | null
  employee_id: string | null
  work_date: string
  pattern_id: string | null
  shift_label: string | null
  start_time: string | null
  end_time: string | null
  break_minutes: number
  work_minutes: number | null
  assignment_type: 'staff' | 'timee' | 'note'
  note: string | null
  source: 'manual' | 'ai' | 'import'
}

type ShiftHoliday = {
  holiday_date: string
  name: string
  holiday_type: string
}

type ShiftCellStyle = {
  work_date: string
  cell_key: string
  background_color: string | null
}

const STATUSES = new Set<ShiftStatus>(['draft', 'collecting', 'generated', 'editing', 'confirmed', 'exported', 'archived'])
const REQUEST_TYPES = new Set<ShiftRequestType>(['day_off', 'unavailable', 'paid_leave_full', 'paid_leave_half', 'available', 'time_preference', 'note'])
const DEFAULT_REQUIRED_COUNT: Record<UserDepartment, number> = {
  フロア: 3,
  製造: 4,
  道の駅: 2,
}
const REGULAR_WORK_STYLES = new Set(['regular_5d_8h', 'regular_6d_6_5h'])
const SALE_COLORS = new Set<ShiftEcSaleColor>(['red', 'green', 'orange'])
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/
const LOCKED_STATUSES = new Set<ShiftStatus>(['confirmed', 'exported', 'archived'])
const SHIFT_PATTERN_ROLES = new Set<ShiftPatternRole>(['standard', 'basic_work', 'floor_work'])

function recordList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function isRegularEmployee(employee: Pick<ShiftEmployee, 'work_style'>) {
  return REGULAR_WORK_STYLES.has(employee.work_style || '')
}

function isBasicShiftPattern(pattern: Pick<ShiftPattern, 'label' | 'pattern_role'>) {
  return pattern.pattern_role === 'basic_work' ||
    pattern.pattern_role === 'floor_work' ||
    pattern.label === 'フロア勤務' ||
    pattern.label === '基本勤務' ||
    pattern.label.startsWith('基本勤務')
}

function patternOptionsForEmployee(employee: ShiftEmployee, patterns: ShiftPattern[]) {
  if (isRegularEmployee(employee)) return patterns
  return patterns.filter((pattern) => {
    if (isBasicShiftPattern(pattern)) return false
    return !!pattern.start_time || !!pattern.end_time || /\d/.test(pattern.label)
  })
}

function defaultPatternForEmployee(employee: ShiftEmployee, patterns: ShiftPattern[]) {
  const options = patternOptionsForEmployee(employee, patterns)
  if (isRegularEmployee(employee)) {
    return options.find((pattern) => pattern.pattern_role === 'basic_work') ||
      options.find((pattern) => pattern.label === '基本勤務') ||
      options[0] ||
      null
  }
  return options[0] || null
}

function basicShiftForEmployee(employee: ShiftEmployee) {
  const startTime = cleanTime(employee.basic_work_start)
  const endTime = cleanTime(employee.basic_work_end)
  if (!startTime || !endTime) return null
  const breakMinutes = Number.isFinite(Number(employee.basic_break_minutes))
    ? Math.max(0, Math.round(Number(employee.basic_break_minutes)))
    : 0
  return {
    startTime,
    endTime,
    breakMinutes,
    label: `${startTime}-${endTime}`,
  }
}

function compactName(value: string | null | undefined) {
  return (value || '').replace(/[\s\u3000]/g, '')
}

function isFujitaKaori(person: Pick<ShiftEmployee, 'display_name' | 'real_name'>) {
  return [person.real_name, person.display_name].map(compactName).some((name) => name === '藤田香織')
}

function preferenceMatchesEmployee(preference: ShiftPatternPreference, employee: ShiftEmployee) {
  if (preference.employee_id && preference.employee_id === employee.id) return true
  if (preference.user_id && preference.user_id === employee.user_id) return true
  if (preference.employee_code && employee.employee_code && preference.employee_code === employee.employee_code) return true

  const preferenceName = compactName(preference.employee_name)
  if (!preferenceName) return false

  const employeeNames = [
    employee.display_name,
    employee.real_name,
  ].map(compactName).filter(Boolean)

  return employeeNames.some((name) => name === preferenceName || name.includes(preferenceName) || preferenceName.includes(name))
}

function preferredPatternForEmployee(options: {
  employee: ShiftEmployee
  patterns: ShiftPattern[]
  preferences: ShiftPatternPreference[]
  dayIndex: number
  candidateIndex: number
}) {
  const employeePatterns = patternOptionsForEmployee(options.employee, options.patterns)
  if (employeePatterns.length === 0) return null

  const matchedPreferences = options.preferences
    .filter((preference) => preferenceMatchesEmployee(preference, options.employee))
    .map((preference) => ({
      ...preference,
      pattern: employeePatterns.find((pattern) => pattern.label === preference.pattern_label) || null,
    }))
    .filter((preference): preference is ShiftPatternPreference & { pattern: ShiftPattern } => !!preference.pattern)
    .sort((a, b) => a.sort_order - b.sort_order || b.weight - a.weight || a.pattern.label.localeCompare(b.pattern.label, 'ja'))

  if (matchedPreferences.length === 0) return defaultPatternForEmployee(options.employee, options.patterns)

  const totalWeight = matchedPreferences.reduce((sum, preference) => sum + Math.max(1, preference.weight || 1), 0)
  let slot = (options.dayIndex * 7 + options.candidateIndex * 3) % Math.max(1, totalWeight)
  for (const preference of matchedPreferences) {
    slot -= Math.max(1, preference.weight || 1)
    if (slot < 0) return preference.pattern
  }

  return matchedPreferences[0].pattern
}

function isFloorEarlyPattern(label: string | null | undefined) {
  const value = label || ''
  return value.includes('早') || value.startsWith('9:30') || value.includes('9:30')
}

function isFloorLatePattern(label: string | null | undefined) {
  const value = label || ''
  return value.includes('遅') || value.startsWith('10:00') || value.includes('10:00')
}

type FloorShiftBalance = {
  byUser: Map<string, { early: number; late: number }>
  byDate: Map<string, { early: number; late: number }>
}

function balanceBucket(map: Map<string, { early: number; late: number }>, key: string) {
  const current = map.get(key) || { early: 0, late: 0 }
  map.set(key, current)
  return current
}

function addFloorBalance(balance: FloorShiftBalance, userId: string, workDate: string, label: string | null | undefined) {
  const kind = isFloorEarlyPattern(label) ? 'early' : isFloorLatePattern(label) ? 'late' : null
  if (!kind) return
  balanceBucket(balance.byUser, userId)[kind] += 1
  balanceBucket(balance.byDate, workDate)[kind] += 1
}

function floorBalancedPatternForEmployee(options: {
  period: ShiftPeriod
  employee: ShiftEmployee
  patterns: ShiftPattern[]
  balance: FloorShiftBalance
  workDate: string
  dayIndex: number
  candidateIndex: number
  commit?: boolean
}) {
  if (options.period.department !== 'フロア' || isRegularEmployee(options.employee)) {
    return defaultPatternForEmployee(options.employee, options.patterns)
  }

  const employeePatterns = patternOptionsForEmployee(options.employee, options.patterns)
  const earlyPattern = employeePatterns.find((pattern) => isFloorEarlyPattern(pattern.label))
  const latePattern = employeePatterns.find((pattern) => isFloorLatePattern(pattern.label))
  if (!earlyPattern || !latePattern) return employeePatterns[0] || null

  const dayBalance = balanceBucket(options.balance.byDate, options.workDate)
  const userBalance = balanceBucket(options.balance.byUser, options.employee.user_id)
  let selected = earlyPattern

  if (dayBalance.early > dayBalance.late) selected = latePattern
  else if (dayBalance.late > dayBalance.early) selected = earlyPattern
  else if (userBalance.early > userBalance.late) selected = latePattern
  else if (userBalance.late > userBalance.early) selected = earlyPattern
  else selected = (options.dayIndex + options.candidateIndex) % 2 === 0 ? earlyPattern : latePattern

  if (options.commit !== false) addFloorBalance(options.balance, options.employee.user_id, options.workDate, selected.label)
  return selected
}

async function requireShiftAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }

  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: '勤怠管理権限が必要です', status: 403, user: null }
  }

  return { error: null, status: 0, user }
}

function cleanText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanDate(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

type ShiftSaleMall = 'rakuten' | 'amazon' | 'yahoo'

type ShiftCalendarEvent = {
  title: string
  description: string | null
  starts_at: string
  ends_at: string
}

const SALE_EVENT_PATTERN = /sale|セール|sall|マラソン|お買い物|プライム|black\s*friday|ブラックフライデー|5の(?:付|つ)く日|日曜日|paypay|爆買い|販促|キャンペーン/i

function saleMallFromCalendarEvent(event: Pick<ShiftCalendarEvent, 'title' | 'description'>): ShiftSaleMall | null {
  const text = `${event.title || ''} ${event.description || ''}`
  if (!SALE_EVENT_PATTERN.test(text)) return null
  if (/楽天|rakuten/i.test(text)) return 'rakuten'
  if (/amazon|アマゾン/i.test(text)) return 'amazon'
  if (/yahoo|ヤフー/i.test(text)) return 'yahoo'
  return null
}

function jstDayStart(dateText: string) {
  return `${dateText}T00:00:00+09:00`
}

async function refreshFloorCalendar(period: ShiftPeriod, requestedBy: string) {
  if (period.department !== 'フロア' || !isAutoGoogleCalendarSyncEnabled()) return null
  const rangeStart = jstDayStart(period.start_date)
  const rangeEnd = jstDayStart(addDays(period.end_date, 1))
  try {
    await syncGoogleCalendarRange({ rangeStart, rangeEnd, requestedBy, force: false })
    return null
  } catch (error) {
    console.error('[admin/shifts] floor calendar sync failed', error)
    return 'Googleカレンダー同期に失敗したため、TSGカレンダーに保存済みの予定で必要人数を判定しました'
  }
}

async function floorRequiredCountsFromCalendar(period: ShiftPeriod) {
  const counts = new Map<string, number>()
  if (period.department !== 'フロア') return counts

  const rangeStart = jstDayStart(period.start_date)
  const rangeEnd = jstDayStart(addDays(period.end_date, 1))
  const { data, error } = await adminClient
    .from('gw_calendar_events')
    .select('title, description, starts_at, ends_at')
    .lt('starts_at', rangeEnd)
    .gt('ends_at', rangeStart)
    .order('starts_at', { ascending: true })
    .limit(2500)

  if (error) throw error
  const saleEvents = ((data || []) as ShiftCalendarEvent[])
    .map((event) => ({ ...event, mall: saleMallFromCalendarEvent(event) }))
    .filter((event): event is ShiftCalendarEvent & { mall: ShiftSaleMall } => Boolean(event.mall))

  for (const workDate of eachDate(period.start_date, period.end_date)) {
    const dayStart = new Date(jstDayStart(workDate)).getTime()
    const dayEnd = new Date(jstDayStart(addDays(workDate, 1))).getTime()
    const malls = new Set<ShiftSaleMall>()
    for (const event of saleEvents) {
      if (new Date(event.starts_at).getTime() < dayEnd && new Date(event.ends_at).getTime() > dayStart) {
        malls.add(event.mall)
      }
    }
    counts.set(workDate, malls.size >= 2 ? 4 : 3)
  }

  return counts
}

function monthEndDate(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function defaultShiftTitle(department: UserDepartment, startDate: string, endDate: string) {
  return `${department} ${startDate}〜${endDate}`
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = []
  if (!startDate || !endDate || startDate > endDate) return dates

  let current = startDate
  while (current <= endDate) {
    dates.push(current)
    current = addDays(current, 1)
  }
  return dates
}

function randomInteger(min: number, max: number) {
  if (max <= min) return min
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomItems<T>(items: T[], count: number) {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(0, index)
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled.slice(0, Math.max(0, Math.min(count, shuffled.length)))
}

function buildRandomShiftTestData(period: ShiftPeriod, employees: ShiftEmployee[]) {
  const dates = eachDate(period.start_date, period.end_date)
  const periodDays = dates.length
  const submittedAt = new Date().toISOString()
  const comments = [
    null,
    null,
    '午前中心の勤務を希望します',
    '連続勤務は少なめを希望します',
    '勤務時間は管理者調整で問題ありません',
  ]
  const requests: Record<string, unknown>[] = []
  const submissions: Record<string, unknown>[] = []

  for (const employee of employees) {
    const defaults = resolveShiftConstraints(employee.work_style, periodDays)
    const minDaysOff = Math.min(periodDays, Math.max(0, defaults.minDaysOff + randomInteger(-1, 1)))
    const maxWorkDays = Math.max(0, periodDays - minDaysOff)
    const targetWorkDays = Math.min(maxWorkDays, Math.max(0, defaults.targetWorkDays + randomInteger(-1, 1)))
    const maxConsecutiveDays = Math.min(periodDays, Math.max(2, defaults.maxConsecutiveDays + randomInteger(-1, 1)))
    const maxRequestedDaysOff = Math.min(minDaysOff, 5)
    const requestedDaysOff = maxRequestedDaysOff > 0
      ? randomInteger(Math.min(2, maxRequestedDaysOff), maxRequestedDaysOff)
      : 0

    for (const workDate of randomItems(dates, requestedDaysOff)) {
      requests.push({
        period_id: period.id,
        user_id: employee.user_id,
        employee_id: employee.id,
        work_date: workDate,
        request_type: 'day_off',
        priority: 'must',
        start_time: null,
        end_time: null,
        memo: null,
        status: 'submitted',
        is_test: true,
        updated_at: submittedAt,
      })
    }

    submissions.push({
      period_id: period.id,
      user_id: employee.user_id,
      employee_id: employee.id,
      request_comment: comments[randomInteger(0, comments.length - 1)],
      max_work_days: maxWorkDays,
      target_work_days: targetWorkDays,
      min_days_off: minDaysOff,
      max_consecutive_days: maxConsecutiveDays,
      is_test: true,
      submitted_at: submittedAt,
      updated_at: submittedAt,
    })
  }

  return { requests, submissions }
}

function mondayOf(dateText: string) {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 15))
  const offset = (date.getUTCDay() + 6) % 7
  return addDays(dateText, -offset)
}

function consecutiveWorkDays(dates: Set<string>, dateText: string) {
  let count = 1
  let cursor = addDays(dateText, -1)
  while (dates.has(cursor)) {
    count += 1
    cursor = addDays(cursor, -1)
  }
  cursor = addDays(dateText, 1)
  while (dates.has(cursor)) {
    count += 1
    cursor = addDays(cursor, 1)
  }
  return count
}

function weeklyDayLimit(workStyle: string | null | undefined) {
  if (workStyle === 'regular_5d_8h') return 5
  if (workStyle === 'regular_6d_6_5h') return 6
  return null
}

function cleanTime(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{2}):(\d{2})(?::\d{2})?$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${match[1]}:${match[2]}`
}

function cleanNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 10) / 10 : null
}

function minutesFromTime(value: string | null) {
  if (!value) return null
  const normalized = cleanTime(value)
  if (!normalized) return null
  const [hour, minute] = normalized.split(':').map(Number)
  return hour * 60 + minute
}

function workMinutes(startTime: string | null, endTime: string | null, breakMinutes: number) {
  const start = minutesFromTime(startTime)
  const end = minutesFromTime(endTime)
  if (start === null || end === null) return null
  const gross = end >= start ? end - start : end + 1440 - start
  return Math.max(0, gross - Math.max(0, breakMinutes || 0))
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined) {
  const value = rawPayload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as {
      deleted_at?: string
      basic_work_start?: string | null
      basic_work_end?: string | null
      basic_break_minutes?: number | null
      shift_sort_order?: number | null
    }
    : {}
}

function isProvisionalShiftProfile(profile: Record<string, unknown>) {
  return profile.provisional_hire === true && profile.shift_visible_before_hire === true
}

function tsgDepartmentFromText(value: unknown): UserDepartment | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment
  if (value.includes('道の駅')) return '道の駅'
  if (value.includes('フロア') || value.includes('売上') || value.includes('ブランド館')) return 'フロア'
  if (value.includes('製造') || value.includes('本社')) return '製造'
  return null
}

function displayName(row: { display_name?: string | null; real_name?: string | null }) {
  return row.real_name || row.display_name || '名称未設定'
}

function sortDate(value: string | null | undefined) {
  if (!value) return Number.MAX_SAFE_INTEGER
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function shiftWorkStyleOrder(value: string | null | undefined) {
  if (value === 'regular_5d_8h' || value === 'regular_6d_6_5h' || value === 'officer') return 0
  if (value === 'part_time_under_29_5h' || value === 'full_time_part') return 1
  return 2
}

const ROAD_STATION_NAME_ORDER = [
  ['佐藤正彦'],
  ['佐藤ちさと'],
  ['生井美穂', '内海美穂', '生井', '内海'],
  ['武藤志保', '武藤'],
  ['角田聖子', '角田'],
  ['新田奈美', '新田'],
]

function compactEmployeeName(value: string) {
  return value.replace(/[\s\u3000（）()]/g, '')
}

function roadStationNameOrder(employee: ShiftEmployee) {
  const name = compactEmployeeName(displayName(employee))
  const index = ROAD_STATION_NAME_ORDER.findIndex((aliases) => aliases.some((alias) => {
    const normalizedAlias = compactEmployeeName(alias)
    return name === normalizedAlias || name.startsWith(normalizedAlias)
  }))
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER
}

async function loadPeriods(department?: UserDepartment | null) {
  let query = adminClient
    .from('gw_shift_periods')
    .select('id, department, title, start_date, end_date, request_deadline, status, notes, is_test_mode, created_at, updated_at')
    .order('start_date', { ascending: false })
    .limit(50)

  if (department) query = query.eq('department', department)

  const { data, error } = await query
  if (error) throw error
  return (data || []) as ShiftPeriod[]
}

async function loadPeriod(periodId: string | null, department?: UserDepartment | null) {
  if (periodId) {
    const { data, error } = await adminClient
      .from('gw_shift_periods')
      .select('id, department, title, start_date, end_date, request_deadline, status, notes, is_test_mode')
      .eq('id', periodId)
      .single()

    if (error) throw error
    return data as ShiftPeriod
  }

  const periods = await loadPeriods(department)
  return periods[0] || null
}

async function loadPatterns(department: UserDepartment) {
  const { data, error } = await adminClient
    .from('gw_shift_patterns')
    .select('id, department, label, start_time, end_time, break_minutes, work_minutes, pattern_role, sort_order, is_active')
    .eq('department', department)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })

  if (error) throw error
  return (data || []) as ShiftPattern[]
}

async function loadPatternPreferences(department: UserDepartment) {
  const { data, error } = await adminClient
    .from('gw_shift_pattern_preferences')
    .select('id, department, employee_id, user_id, employee_code, employee_name, pattern_label, weight, sort_order')
    .eq('department', department)
    .order('sort_order', { ascending: true })
    .order('weight', { ascending: false })

  if (error) throw error
  return (data || []) as ShiftPatternPreference[]
}

async function loadSaleOptions() {
  const { data, error } = await adminClient
    .from('gw_shift_ec_sales')
    .select('id, label, color, start_time, end_time, sort_order, is_active')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })

  if (error) throw error
  return (data || []) as ShiftEcSaleOption[]
}

async function loadShiftEmployees(department: UserDepartment) {
  const [
    { data: employees, error: employeesError },
    { data: users, error: usersError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status, raw_payload')
      .in('payroll_status', ['active', 'inactive']),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, department, status')
      .eq('status', 'approved'),
  ])

  const dbError = employeesError || usersError
  if (dbError) throw dbError

  const userMap = new Map((users || []).map((user) => [user.id, user]))
  return ((employees || []) as Array<ShiftEmployee & { raw_payload?: Record<string, unknown> | null }>)
    .filter((employee) => {
      const profile = hrProfile(employee.raw_payload)
      return employee.user_id && !profile.deleted_at && (
        employee.payroll_status === 'active' || isProvisionalShiftProfile(profile)
      )
    })
    .map((employee) => {
      const user = employee.user_id ? userMap.get(employee.user_id) : null
      const profile = hrProfile(employee.raw_payload)
      const normalizedDepartment =
        tsgDepartmentFromText(user?.department) ||
        tsgDepartmentFromText(employee.department) ||
        normalizeUserDepartment(employee.department)

      const resolvedEmployee = {
        ...employee,
        user_id: employee.user_id!,
        display_name: displayName({ display_name: user?.display_name || employee.display_name, real_name: user?.real_name || employee.real_name }),
        real_name: user?.real_name || employee.real_name || null,
        department: normalizedDepartment,
        basic_work_start: cleanTime(profile.basic_work_start) || null,
        basic_work_end: cleanTime(profile.basic_work_end) || null,
        basic_break_minutes: typeof profile.basic_break_minutes === 'number' ? profile.basic_break_minutes : null,
        shift_sort_order: typeof profile.shift_sort_order === 'number' && Number.isFinite(profile.shift_sort_order)
          ? profile.shift_sort_order
          : null,
      }
      return {
        ...resolvedEmployee,
        request_collection_excluded: isProvisionalShiftProfile(profile) || isShiftRequestCollectionExcluded(resolvedEmployee),
      }
    })
    .filter((employee) => employee.department === department && !isShiftRosterExcluded(employee))
    .sort((a, b) => {
      const aHasCustomOrder = a.shift_sort_order !== null
      const bHasCustomOrder = b.shift_sort_order !== null
      if (aHasCustomOrder || bHasCustomOrder) {
        if (aHasCustomOrder && bHasCustomOrder) {
          const customDiff = (a.shift_sort_order || 0) - (b.shift_sort_order || 0)
          if (customDiff) return customDiff
        } else {
          return aHasCustomOrder ? -1 : 1
        }
      }
      if (department === '道の駅') {
        const roadStationDiff = roadStationNameOrder(a) - roadStationNameOrder(b)
        if (roadStationDiff) return roadStationDiff
      }
      const styleDiff = shiftWorkStyleOrder(a.work_style) - shiftWorkStyleOrder(b.work_style)
      if (styleDiff) return styleDiff
      const hireDiff = sortDate(a.hire_date) - sortDate(b.hire_date)
      return hireDiff || displayName(a).localeCompare(displayName(b), 'ja')
    })
}

async function loadExcludedUserIds(periodId: string) {
  const { data, error } = await adminClient
    .from('gw_shift_period_exclusions')
    .select('user_id')
    .eq('period_id', periodId)

  if (error) throw error
  return new Set((data || []).map((row) => row.user_id))
}

async function loadPeriodDetails(period: ShiftPeriod | null, fallbackDepartment: UserDepartment = 'フロア') {
  if (!period) {
    const [employees, patterns, patternPreferences] = await Promise.all([
      loadShiftEmployees(fallbackDepartment),
      loadPatterns(fallbackDepartment),
      loadPatternPreferences(fallbackDepartment),
    ])
    return {
      employees,
      excludedEmployees: [] as ShiftEmployee[],
      patterns,
      requirements: [] as ShiftRequirement[],
      requests: [] as ShiftRequestRow[],
      requestTargets: [] as ShiftRequestTarget[],
      requestSubmissions: [] as ShiftRequestSubmission[],
      assignments: [] as ShiftAssignment[],
      holidays: [] as ShiftHoliday[],
      cellStyles: [] as ShiftCellStyle[],
      patternPreferences,
      summary: { days: 0, staff: employees.length, targets: 0, requests: 0, submissions: 0, assignments: 0, warnings: [] as string[] },
    }
  }

  const [allEmployees, patterns, patternPreferences, requirementsResult, requestsResult, requestTargetsResult, requestSubmissionsResult, assignmentsResult, holidaysResult, cellStylesResult, exclusionsResult] = await Promise.all([
    loadShiftEmployees(period.department),
    loadPatterns(period.department),
    loadPatternPreferences(period.department),
    adminClient
      .from('gw_shift_requirements')
      .select('id, period_id, work_date, required_count, workplace_label, notes, notes2, notes3, production_plan, timee_count, ec_sale_tags, ec_sale_times')
      .eq('period_id', period.id)
      .order('work_date', { ascending: true }),
    adminClient
      .from('gw_shift_requests')
      .select('id, period_id, user_id, employee_id, work_date, request_type, priority, start_time, end_time, memo, is_test')
      .eq('period_id', period.id)
      .order('work_date', { ascending: true }),
    adminClient
      .from('gw_shift_request_targets')
      .select('id, period_id, user_id, employee_id, requested_at')
      .eq('period_id', period.id)
      .order('requested_at', { ascending: false }),
    adminClient
      .from('gw_shift_request_submissions')
      .select('id, period_id, user_id, employee_id, submitted_at, request_comment, max_work_days, target_work_days, min_days_off, max_consecutive_days, is_test')
      .eq('period_id', period.id)
      .order('submitted_at', { ascending: false }),
    adminClient
      .from('gw_shift_assignments')
      .select('id, period_id, user_id, employee_id, work_date, pattern_id, shift_label, start_time, end_time, break_minutes, work_minutes, assignment_type, note, source')
      .eq('period_id', period.id)
      .order('work_date', { ascending: true }),
    adminClient
      .from('gw_holidays')
      .select('holiday_date, name, holiday_type')
      .gte('holiday_date', period.start_date)
      .lte('holiday_date', period.end_date)
      .order('holiday_date', { ascending: true }),
    adminClient
      .from('gw_shift_cell_styles')
      .select('work_date, cell_key, background_color')
      .eq('period_id', period.id)
      .order('work_date', { ascending: true }),
    adminClient
      .from('gw_shift_period_exclusions')
      .select('id, period_id, user_id, employee_id, excluded_at')
      .eq('period_id', period.id)
      .order('excluded_at', { ascending: false }),
  ])

  const dbError = requirementsResult.error || requestsResult.error || requestTargetsResult.error || requestSubmissionsResult.error || assignmentsResult.error || holidaysResult.error || cellStylesResult.error || exclusionsResult.error
  if (dbError) throw dbError

  const exclusions = (exclusionsResult.data || []) as ShiftPeriodExclusion[]
  const excludedUserIds = new Set(exclusions.map((exclusion) => exclusion.user_id))
  const employees = allEmployees.filter((employee) => !excludedUserIds.has(employee.user_id))
  const excludedEmployees = allEmployees.filter((employee) => excludedUserIds.has(employee.user_id))
  const rosterUserIds = new Set(allEmployees.map((employee) => employee.user_id))
  const requirements = (requirementsResult.data || []) as ShiftRequirement[]
  const assignments = ((assignmentsResult.data || []) as ShiftAssignment[])
    .filter((assignment) => !assignment.user_id || (rosterUserIds.has(assignment.user_id) && !excludedUserIds.has(assignment.user_id)))
  const requests = ((requestsResult.data || []) as ShiftRequestRow[])
    .filter((request) => period.is_test_mode || !excludedUserIds.has(request.user_id))
  const submissions = ((requestSubmissionsResult.data || []) as ShiftRequestSubmission[])
    .filter((submission) => period.is_test_mode || !excludedUserIds.has(submission.user_id))
  const periodDays = eachDate(period.start_date, period.end_date).length
  const validateTargets = !['draft', 'collecting'].includes(period.status)
  const paidLeaveFullKeys = new Set(
    requests
      .filter((request) => request.request_type === 'paid_leave_full')
      .map((request) => `${request.user_id}:${request.work_date}`),
  )
  const warnings = requirements.flatMap((requirement) => {
    const required = Number(requirement.required_count ?? (validateTargets ? DEFAULT_REQUIRED_COUNT[period.department] : 0))
    if (!required) return []
    const assignedStaff = assignments.filter((assignment) => (
      assignment.work_date === requirement.work_date &&
      countsTowardDepartmentHeadcount(period.department, assignment) &&
      !paidLeaveFullKeys.has(`${assignment.user_id}:${assignment.work_date}`)
    )).length
    const assigned = assignedStaff + (period.department === '道の駅'
      ? shiftTimeeHeadcount(requirement.notes2, requirement.notes3, requirement.timee_count)
      : 0)
    return assigned < required ? [`${requirement.work_date}: 必要${required}名 / 割当${assigned}名`] : []
  })
  const submissionByUser = new Map(submissions.map((submission) => [submission.user_id, submission]))

  for (const employee of employees) {
    const employeeAssignments = assignments.filter((assignment) => assignment.user_id === employee.user_id && !!assignment.shift_label)
    const assignedDates = new Set(employeeAssignments.map((assignment) => assignment.work_date))
    const submission = submissionByUser.get(employee.user_id)
    const constraints = resolveShiftConstraints(employee.work_style, periodDays, {
      maxWorkDays: submission?.max_work_days,
      targetWorkDays: submission?.target_work_days,
      minDaysOff: submission?.min_days_off,
      maxConsecutiveDays: submission?.max_consecutive_days,
    })
    const name = displayName(employee)

    if (assignedDates.size > constraints.effectiveMaxWorkDays) {
      warnings.push(`${name}: 出勤${assignedDates.size}日が上限${constraints.effectiveMaxWorkDays}日を超えています`)
    } else if (validateTargets && submission && assignedDates.size < constraints.targetWorkDays) {
      warnings.push(`${name}: 希望${constraints.targetWorkDays}日に対して割当${assignedDates.size}日です`)
    }

    for (const date of assignedDates) {
      if (consecutiveWorkDays(assignedDates, date) > constraints.maxConsecutiveDays) {
        warnings.push(`${name}: 最大${constraints.maxConsecutiveDays}連勤を超えています`)
        break
      }
    }

    const weeklyDays = new Map<string, number>()
    const weeklyMinutes = new Map<string, number>()
    for (const assignment of employeeAssignments) {
      const week = mondayOf(assignment.work_date)
      weeklyDays.set(week, (weeklyDays.get(week) || 0) + 1)
      const minutes = assignment.work_minutes ?? workMinutes(assignment.start_time, assignment.end_time, assignment.break_minutes) ?? 0
      weeklyMinutes.set(week, (weeklyMinutes.get(week) || 0) + minutes)
    }
    const dayLimit = weeklyDayLimit(employee.work_style)
    if (dayLimit && [...weeklyDays.values()].some((count) => count > dayLimit)) {
      warnings.push(`${name}: ${shiftWorkStyleLabel(employee.work_style)}の週${dayLimit}日を超えています`)
    }
    if (employee.work_style === 'part_time_under_29_5h' && [...weeklyMinutes.values()].some((minutes) => minutes > 1770)) {
      warnings.push(`${name}: パートの週29.5時間を超えています`)
    }
  }

  const rawRequestTargets = (requestTargetsResult.data || []) as ShiftRequestTarget[]
  const requestTargets = period.is_test_mode
    ? rawRequestTargets
    : rawRequestTargets
      .filter((target) => !excludedUserIds.has(target.user_id))
      .filter((target) => employees.some((employee) => employee.user_id === target.user_id && !employee.request_collection_excluded))

  return {
    employees,
    excludedEmployees,
    patterns,
    patternPreferences,
    requirements,
    requests,
    requestTargets,
    requestSubmissions: submissions,
    assignments,
    holidays: (holidaysResult.data || []) as ShiftHoliday[],
    cellStyles: (cellStylesResult.data || []) as ShiftCellStyle[],
    summary: {
      days: requirements.length || eachDate(period.start_date, period.end_date).length,
      staff: employees.length,
      targets: period.is_test_mode ? submissions.length : requestTargets.length,
      requests: requests.length,
      submissions: submissions.length,
      assignments: assignments.filter((assignment) => !!assignment.shift_label).length,
      warnings,
    },
  }
}

function requirementPayload(body: Record<string, unknown>, periodId: string, workDate: string, department: UserDepartment) {
  const saleIds = department === 'フロア' ? normalizeShiftEcSaleIds(body.ec_sale_tags) : []
  return {
    period_id: periodId,
    work_date: workDate,
    required_count: cleanNumber(body.required_count),
    workplace_label: cleanText(body.workplace_label, 80) || null,
    notes: cleanText(body.notes, 300) || null,
    notes2: cleanText(body.notes2, 300) || null,
    notes3: cleanText(body.notes3, 300) || null,
    production_plan: cleanText(body.production_plan, 500) || null,
    timee_count: cleanNumber(body.timee_count),
    ec_sale_tags: saleIds,
    ec_sale_times: normalizeShiftEcSaleTimes(body.ec_sale_times, saleIds),
    updated_at: new Date().toISOString(),
  }
}

function assignmentPayload(options: {
  body: Record<string, unknown>
  periodId: string
  workDate: string
  pattern: ShiftPattern | null
  employee?: ShiftEmployee | null
  actorId: string
  employeeId?: string | null
}) {
  const shiftLabel = cleanText(options.body.shift_label, 120)
  const requestedStart = cleanTime(options.body.start_time)
  const requestedEnd = cleanTime(options.body.end_time)
  const patternStart = cleanTime(options.pattern?.start_time || null)
  const patternEnd = cleanTime(options.pattern?.end_time || null)
  const personalBasic = options.employee && options.pattern && isBasicShiftPattern(options.pattern)
    ? basicShiftForEmployee(options.employee)
    : null
  const usesPatternDefault = Boolean(personalBasic && (
    (!requestedStart && !requestedEnd) ||
    (requestedStart === patternStart && requestedEnd === patternEnd)
  ))
  const startTime = usesPatternDefault
    ? personalBasic?.startTime || null
    : requestedStart || personalBasic?.startTime || patternStart
  const endTime = usesPatternDefault
    ? personalBasic?.endTime || null
    : requestedEnd || personalBasic?.endTime || patternEnd
  const breakMinutes = usesPatternDefault
    ? personalBasic?.breakMinutes || 0
    : options.body.break_minutes === null || options.body.break_minutes === undefined || options.body.break_minutes === ''
      ? personalBasic?.breakMinutes ?? options.pattern?.break_minutes ?? 0
      : Math.max(0, Number(options.body.break_minutes) || 0)
  const calculatedWorkMinutes = workMinutes(startTime, endTime, breakMinutes)

  return {
    period_id: options.periodId,
    user_id: cleanText(options.body.user_id, 80),
    employee_id: cleanText(options.body.employee_id, 80) || options.employeeId || null,
    work_date: options.workDate,
    pattern_id: options.pattern?.id || null,
    shift_label: shiftLabel || null,
    start_time: startTime,
    end_time: endTime,
    break_minutes: breakMinutes,
    work_minutes: calculatedWorkMinutes ?? options.pattern?.work_minutes ?? null,
    assignment_type: 'staff',
    note: cleanText(options.body.note, 300) || null,
    source: 'manual',
    updated_by: options.actorId,
    updated_at: new Date().toISOString(),
  }
}

async function ensureRequirementRows(period: ShiftPeriod, updateFloorCounts = false) {
  const floorRequiredCounts = await floorRequiredCountsFromCalendar(period)
  const rows = eachDate(period.start_date, period.end_date).map((workDate) => ({
    period_id: period.id,
    work_date: workDate,
    workplace_label: period.department === '道の駅' ? '道の駅' : '本社',
    required_count: floorRequiredCounts.get(workDate) ?? DEFAULT_REQUIRED_COUNT[period.department],
    updated_at: new Date().toISOString(),
  }))

  if (rows.length === 0) return

  const { error } = await adminClient
    .from('gw_shift_requirements')
    .upsert(rows, { onConflict: 'period_id,work_date', ignoreDuplicates: !updateFloorCounts })

  if (error) throw error
}

async function generateDraft(period: ShiftPeriod, actorId: string, overwriteAi: boolean) {
  const calendarWarning = await refreshFloorCalendar(period, actorId)
  await ensureRequirementRows(period, period.department === 'フロア')
  if (overwriteAi) {
    const { error } = await adminClient
      .from('gw_shift_assignments')
      .delete()
      .eq('period_id', period.id)
      .eq('source', 'ai')
    if (error) throw error
  }

  const details = await loadPeriodDetails(period)
  if (details.patterns.length === 0) return { inserted: 0, warnings: ['勤務パターンが未設定です'] }

  const requestsByUserDate = new Map<string, ShiftRequestRow>()
  for (const request of details.requests) {
    requestsByUserDate.set(`${request.user_id}:${request.work_date}`, request)
  }

  const periodDays = eachDate(period.start_date, period.end_date).length
  const submissionByUser = new Map(details.requestSubmissions.map((submission) => [submission.user_id, submission]))
  const constraintsByUser = new Map<string, ShiftConstraints>()
  for (const employee of details.employees) {
    const submission = submissionByUser.get(employee.user_id)
    constraintsByUser.set(employee.user_id, resolveShiftConstraints(employee.work_style, periodDays, {
      maxWorkDays: submission?.max_work_days,
      targetWorkDays: submission?.target_work_days,
      minDaysOff: submission?.min_days_off,
      maxConsecutiveDays: submission?.max_consecutive_days,
    }))
  }

  const maxLookback = Math.max(6, ...[...constraintsByUser.values()].map((constraint) => constraint.maxConsecutiveDays))
  const contextStart = [addDays(period.start_date, -maxLookback), mondayOf(period.start_date)].sort()[0]
  const userIds = details.employees.map((employee) => employee.user_id)
  const contextResult = userIds.length > 0
    ? await adminClient
      .from('gw_shift_assignments')
      .select('id, period_id, user_id, employee_id, work_date, pattern_id, shift_label, start_time, end_time, break_minutes, work_minutes, assignment_type, note, source')
      .in('user_id', userIds)
      .neq('period_id', period.id)
      .gte('work_date', contextStart)
      .lt('work_date', period.start_date)
    : { data: [], error: null }
  if (contextResult.error) throw contextResult.error

  type EmployeeGenerationState = {
    periodAssigned: number
    dates: Set<string>
    weeklyDays: Map<string, number>
    weeklyMinutes: Map<string, number>
  }
  const stateByUser = new Map<string, EmployeeGenerationState>()
  for (const employee of details.employees) {
    stateByUser.set(employee.user_id, {
      periodAssigned: 0,
      dates: new Set<string>(),
      weeklyDays: new Map<string, number>(),
      weeklyMinutes: new Map<string, number>(),
    })
  }

  const existingByUserDate = new Map<string, ShiftAssignment>()
  const explicitCompanyOffKeys = new Set(
    details.assignments
      .filter((assignment) => assignment.user_id && isCompanyOffAssignment(assignment))
      .map((assignment) => `${assignment.user_id}:${assignment.work_date}`),
  )
  const stateAssignments = [...((contextResult.data || []) as ShiftAssignment[]), ...details.assignments]
  const seenStateDates = new Set<string>()
  for (const assignment of stateAssignments) {
    if (!assignment.user_id || !assignment.shift_label) continue
    const state = stateByUser.get(assignment.user_id)
    if (!state) continue
    const stateKey = `${assignment.user_id}:${assignment.work_date}`
    if (seenStateDates.has(stateKey)) continue
    seenStateDates.add(stateKey)
    state.dates.add(assignment.work_date)
    const week = mondayOf(assignment.work_date)
    state.weeklyDays.set(week, (state.weeklyDays.get(week) || 0) + 1)
    const minutes = assignment.work_minutes ?? workMinutes(assignment.start_time, assignment.end_time, assignment.break_minutes) ?? 0
    state.weeklyMinutes.set(week, (state.weeklyMinutes.get(week) || 0) + minutes)
    if (assignment.period_id === period.id) state.periodAssigned += 1
    if (assignment.period_id === period.id) existingByUserDate.set(stateKey, assignment)
  }
  const floorShiftBalance: FloorShiftBalance = { byUser: new Map(), byDate: new Map() }
  for (const assignment of details.assignments) {
    if (!assignment.user_id || !assignment.shift_label) continue
    addFloorBalance(floorShiftBalance, assignment.user_id, assignment.work_date, assignment.shift_label)
  }

  const upserts: Record<string, unknown>[] = []
  const warnings: string[] = calendarWarning ? [calendarWarning] : []
  const fujita = period.department === 'フロア'
    ? details.employees.find((employee) => isFujitaKaori(employee)) || null
    : null
  const floorWorkPattern = period.department === 'フロア'
    ? details.patterns.find((pattern) => pattern.pattern_role === 'floor_work') ||
      details.patterns.find((pattern) => pattern.label === 'フロア勤務') ||
      null
    : null
  const basicWorkPattern = period.department === 'フロア'
    ? details.patterns.find((pattern) => pattern.pattern_role === 'basic_work') ||
      details.patterns.find((pattern) => pattern.label === '基本勤務') ||
      null
    : null
  const requirements = details.requirements.length
    ? details.requirements
    : eachDate(period.start_date, period.end_date).map((date) => ({ period_id: period.id, work_date: date, required_count: DEFAULT_REQUIRED_COUNT[period.department] } as ShiftRequirement))

  requirements.forEach((requirement, dayIndex) => {
    const required = Number(requirement.required_count || DEFAULT_REQUIRED_COUNT[period.department])
    const date = requirement.work_date
    const currentStaffingAssignments = details.assignments.filter((assignment) => {
      if (assignment.work_date !== date || !countsTowardDepartmentHeadcount(period.department, assignment)) return false
      if (assignment.user_id && requestsByUserDate.get(`${assignment.user_id}:${date}`)?.request_type === 'paid_leave_full') return false
      if (assignment.source === 'ai' && overwriteAi) return false
      if (
        fujita &&
        assignment.user_id === fujita.user_id &&
        (
          assignment.shift_label === '基本勤務' ||
          (basicWorkPattern && (
            assignment.pattern_id === basicWorkPattern.id ||
            assignment.shift_label === basicWorkPattern.label
          ))
        )
      ) return false
      return true
    })
    const timeeCount = period.department === '道の駅'
      ? shiftTimeeHeadcount(requirement.notes2, requirement.notes3, requirement.timee_count)
      : 0
    const missing = Math.max(0, Math.ceil(required) - currentStaffingAssignments.length - timeeCount)
    if (missing === 0 && period.department !== 'フロア') return

    const exclusionReasons = new Set<string>()
    const candidateOptions = details.employees.flatMap((employee, employeeIndex) => {
      if (employee.hire_date && date < employee.hire_date) {
        exclusionReasons.add(`${displayName(employee)}:入社前`)
        return []
      }
      const request = requestsByUserDate.get(`${employee.user_id}:${date}`)
      if (request?.request_type === 'day_off' || request?.request_type === 'unavailable' || request?.request_type === 'paid_leave_full') {
        exclusionReasons.add(`${displayName(employee)}:休み希望`)
        return []
      }
      if (explicitCompanyOffKeys.has(`${employee.user_id}:${date}`)) {
        exclusionReasons.add(`${displayName(employee)}:会社休`)
        return []
      }
      if (existingByUserDate.has(`${employee.user_id}:${date}`)) return []

      const state = stateByUser.get(employee.user_id)
      const constraints = constraintsByUser.get(employee.user_id)
      if (!state || !constraints) return []
      if (state.periodAssigned >= constraints.effectiveMaxWorkDays) {
        exclusionReasons.add(`${displayName(employee)}:出勤上限`)
        return []
      }

      const isFujita = fujita?.user_id === employee.user_id
      const defaultPattern = isFujita && floorWorkPattern
        ? floorWorkPattern
        : period.department === 'フロア'
          ? floorBalancedPatternForEmployee({
          period,
          employee,
          patterns: details.patterns,
          balance: floorShiftBalance,
          workDate: date,
          dayIndex,
          candidateIndex: employeeIndex,
          commit: false,
          })
          : preferredPatternForEmployee({
          employee,
          patterns: details.patterns,
          preferences: details.patternPreferences,
          dayIndex,
          candidateIndex: employeeIndex,
          })
      if (!defaultPattern) {
        exclusionReasons.add(`${displayName(employee)}:勤務時間未設定`)
        return []
      }

      const basicShift = period.department === '製造' || isBasicShiftPattern(defaultPattern)
        ? basicShiftForEmployee(employee)
        : null
      const startTime = request?.request_type === 'time_preference'
        ? cleanTime(request.start_time) || basicShift?.startTime || defaultPattern.start_time
        : basicShift?.startTime || defaultPattern.start_time
      const endTime = request?.request_type === 'time_preference'
        ? cleanTime(request.end_time) || basicShift?.endTime || defaultPattern.end_time
        : basicShift?.endTime || defaultPattern.end_time
      const breakMinutes = basicShift?.breakMinutes ?? defaultPattern.break_minutes ?? 0
      const shiftLabel = period.department === '製造' && basicShift?.label
        ? basicShift.label
        : defaultPattern.label
      const minutes = workMinutes(startTime, endTime, breakMinutes) ?? defaultPattern.work_minutes ?? 0
      const nextDates = new Set(state.dates)
      nextDates.add(date)
      if (consecutiveWorkDays(nextDates, date) > constraints.maxConsecutiveDays) {
        exclusionReasons.add(`${displayName(employee)}:${constraints.maxConsecutiveDays}連勤上限`)
        return []
      }

      const week = mondayOf(date)
      const dayLimit = weeklyDayLimit(employee.work_style)
      if (dayLimit && (state.weeklyDays.get(week) || 0) + 1 > dayLimit) {
        exclusionReasons.add(`${displayName(employee)}:週${dayLimit}日上限`)
        return []
      }
      if (employee.work_style === 'part_time_under_29_5h') {
        if (minutes <= 0) {
          exclusionReasons.add(`${displayName(employee)}:勤務時間未設定`)
          return []
        }
        if ((state.weeklyMinutes.get(week) || 0) + minutes > 1770) {
          exclusionReasons.add(`${displayName(employee)}:週29.5時間上限`)
          return []
        }
      }

      const targetDeficit = Math.max(0, constraints.targetWorkDays - state.periodAssigned)
      const requestBonus = request?.request_type === 'available' ? 40 : 0
      const rotation = (employeeIndex - dayIndex + details.employees.length) % Math.max(1, details.employees.length)
      const reservePenalty = isFujita ? 1000000 : 0
      const score = targetDeficit * 1000 - state.periodAssigned * 40 + requestBonus - rotation - reservePenalty
      return [{ employee, request, pattern: defaultPattern, shiftLabel, startTime, endTime, breakMinutes, minutes, score, isFujita }]
    }).sort((a, b) => b.score - a.score)

    const candidates = candidateOptions.slice(0, missing)

    if (candidates.length < missing) {
      const reasonText = [...exclusionReasons].slice(0, 4).join('、')
      warnings.push(`${date}: 必要${required}名に対して候補が${currentStaffingAssignments.length + candidates.length}名です${reasonText ? `（${reasonText}）` : ''}`)
    }

    for (const candidate of candidates) {
      const { employee, request, pattern: defaultPattern, shiftLabel, startTime, endTime, breakMinutes, minutes } = candidate
      upserts.push({
        period_id: period.id,
        user_id: employee.user_id,
        employee_id: employee.id,
        work_date: date,
        pattern_id: defaultPattern.id,
        shift_label: shiftLabel,
        start_time: startTime,
        end_time: endTime,
        break_minutes: breakMinutes,
        work_minutes: workMinutes(startTime, endTime, breakMinutes) ?? defaultPattern.work_minutes,
        assignment_type: 'staff',
        note: request?.request_type === 'time_preference' ? request.memo || '時間希望あり' : null,
        source: 'ai',
        created_by: actorId,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      existingByUserDate.set(`${employee.user_id}:${date}`, upserts[upserts.length - 1] as unknown as ShiftAssignment)
      const state = stateByUser.get(employee.user_id)!
      state.periodAssigned += 1
      state.dates.add(date)
      const week = mondayOf(date)
      state.weeklyDays.set(week, (state.weeklyDays.get(week) || 0) + 1)
      state.weeklyMinutes.set(week, (state.weeklyMinutes.get(week) || 0) + minutes)
      addFloorBalance(floorShiftBalance, employee.user_id, date, shiftLabel)
    }

    const fujitaCandidate = candidateOptions.find((candidate) => candidate.isFujita)
    const fujitaWasAssignedToFloor = candidates.some((candidate) => candidate.isFujita)
    const fujitaState = fujita ? stateByUser.get(fujita.user_id) : null
    const fujitaConstraints = fujita ? constraintsByUser.get(fujita.user_id) : null
    if (
      fujita &&
      basicWorkPattern &&
      fujitaCandidate &&
      !fujitaWasAssignedToFloor &&
      !existingByUserDate.has(`${fujita.user_id}:${date}`) &&
      fujitaState &&
      fujitaConstraints &&
      fujitaState.periodAssigned < fujitaConstraints.targetWorkDays
    ) {
      const personalBasic = basicShiftForEmployee(fujita)
      const startTime = personalBasic?.startTime || basicWorkPattern.start_time
      const endTime = personalBasic?.endTime || basicWorkPattern.end_time
      const breakMinutes = personalBasic?.breakMinutes ?? basicWorkPattern.break_minutes ?? 0
      const minutes = workMinutes(startTime, endTime, breakMinutes) ?? basicWorkPattern.work_minutes ?? 0
      upserts.push({
        period_id: period.id,
        user_id: fujita.user_id,
        employee_id: fujita.id,
        work_date: date,
        pattern_id: basicWorkPattern.id,
        shift_label: basicWorkPattern.label,
        start_time: startTime,
        end_time: endTime,
        break_minutes: breakMinutes,
        work_minutes: minutes,
        assignment_type: 'staff',
        note: null,
        source: 'ai',
        created_by: actorId,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      existingByUserDate.set(`${fujita.user_id}:${date}`, upserts[upserts.length - 1] as unknown as ShiftAssignment)
      fujitaState.periodAssigned += 1
      fujitaState.dates.add(date)
      const week = mondayOf(date)
      fujitaState.weeklyDays.set(week, (fujitaState.weeklyDays.get(week) || 0) + 1)
      fujitaState.weeklyMinutes.set(week, (fujitaState.weeklyMinutes.get(week) || 0) + minutes)
    }
  })

  for (const employee of details.employees) {
    const state = stateByUser.get(employee.user_id)
    const constraints = constraintsByUser.get(employee.user_id)
    const submission = submissionByUser.get(employee.user_id)
    if (state && constraints && submission && state.periodAssigned < constraints.targetWorkDays) {
      warnings.push(`${displayName(employee)}: 希望${constraints.targetWorkDays}日に対して${state.periodAssigned}日まで割当`)
    }
  }

  const workUpsertCount = upserts.filter((assignment) => Boolean(assignment.shift_label)).length
  let companyOffCount = explicitCompanyOffKeys.size
  for (const employee of details.employees) {
    for (const date of eachDate(period.start_date, period.end_date)) {
      if (employee.hire_date && date < employee.hire_date) continue
      const key = `${employee.user_id}:${date}`
      const request = requestsByUserDate.get(key)
      if (request?.request_type === 'day_off' || request?.request_type === 'unavailable' || request?.request_type === 'paid_leave_full') continue
      if (existingByUserDate.has(key) || explicitCompanyOffKeys.has(key)) continue
      upserts.push({
        period_id: period.id,
        user_id: employee.user_id,
        employee_id: employee.id,
        work_date: date,
        pattern_id: null,
        shift_label: null,
        start_time: null,
        end_time: null,
        break_minutes: 0,
        work_minutes: null,
        assignment_type: 'staff',
        note: SHIFT_COMPANY_OFF_NOTE,
        source: 'ai',
        created_by: actorId,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      companyOffCount += 1
    }
  }

  if (upserts.length > 0) {
    const { error } = await adminClient
      .from('gw_shift_assignments')
      .upsert(upserts, { onConflict: 'period_id,user_id,work_date' })
    if (error) throw error
  }

  try {
    await adminClient
      .from('gw_shift_generation_runs')
      .insert({
        period_id: period.id,
        status: 'completed',
        prompt: {
          patternRule: 'staff_constraints_with_work_style_weekly_limits_and_preferences',
          overwriteAi,
          partWeeklyMinuteLimit: 1770,
        },
        result: { inserted: workUpsertCount, companyOff: companyOffCount },
        warnings,
        created_by: actorId,
      })
  } catch {
    // Generation history is useful for audit, but draft creation should not fail on history write only.
  }

  if (period.status === 'draft' || period.status === 'collecting') {
    await adminClient
      .from('gw_shift_periods')
      .update({ status: 'generated', updated_at: new Date().toISOString() })
      .eq('id', period.id)
  }

  return { inserted: workUpsertCount, companyOff: companyOffCount, warnings }
}

export async function GET(request: NextRequest) {
  const auth = await requireShiftAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const periodId = request.nextUrl.searchParams.get('period_id')
  const departmentParam = request.nextUrl.searchParams.get('department')
  const department = departmentParam ? normalizeUserDepartment(departmentParam) : null

  try {
    const selectedPeriod = await loadPeriod(periodId, department)
    if (selectedPeriod) await ensureRequirementRows(selectedPeriod)
    const calendarSales = selectedPeriod ? await syncFloorShiftSales(selectedPeriod, auth.user!.id, request.nextUrl.searchParams.get('calendar_refresh') === '1').catch(() => ({
      warning: 'セールの自動入力に失敗しました。入力済みの内容を保持しています。再読込で再試行してください',
    })) : null
    const periods = await loadPeriods(selectedPeriod?.department || department)
    const [details, saleOptions] = await Promise.all([
      loadPeriodDetails(selectedPeriod, selectedPeriod?.department || department || 'フロア'),
      loadSaleOptions(),
    ])

    return NextResponse.json({
      periods,
      selectedPeriod,
      department: selectedPeriod?.department || department || 'フロア',
      saleOptions,
      calendar_sales: calendarSales,
      ...details,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'シフト情報の取得に失敗しました' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireShiftAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const department = normalizeUserDepartment(body.department)
  const startDate = cleanDate(body.start_date)
  const endDate = cleanDate(body.end_date)
  const requestDeadline = cleanDate(body.request_deadline)

  if (!startDate || !endDate || startDate > endDate) {
    return NextResponse.json({ error: '期間を確認してください' }, { status: 400 })
  }
  if (eachDate(startDate, endDate).length > 90) {
    return NextResponse.json({ error: 'シフト期間は90日以内で作成してください' }, { status: 400 })
  }
  const title = defaultShiftTitle(department, startDate, endDate)

  const { data, error } = await adminClient
    .from('gw_shift_periods')
    .insert({
      department,
      title,
      start_date: startDate,
      end_date: endDate,
      request_deadline: requestDeadline || null,
      status: 'draft',
      notes: cleanText(body.notes, 500) || null,
      created_by: auth.user!.id,
    })
    .select('id, department, title, start_date, end_date, request_deadline, status, notes, is_test_mode')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'シフト期間の作成に失敗しました' }, { status: 500 })
  }

  let calendarWarning: string | null = null
  try {
    calendarWarning = await refreshFloorCalendar(data as ShiftPeriod, auth.user!.id)
    await ensureRequirementRows(data as ShiftPeriod)
    const sales = await syncFloorShiftSales(data as ShiftPeriod, auth.user!.id)
    calendarWarning = sales?.warning || calendarWarning
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '必要人数行の作成に失敗しました' }, { status: 500 })
  }

  return NextResponse.json({ success: true, period: data, calendar_warning: calendarWarning })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireShiftAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 60)
  const periodId = cleanText(body.period_id, 80)

  try {
    if (action === 'create_sale') {
      const label = cleanText(body.label, 100)
      const color = cleanText(body.color, 20) as ShiftEcSaleColor
      const startTime = cleanTime(body.start_time)
      const endTime = cleanTime(body.end_time)
      if (!label) return NextResponse.json({ error: 'ECセール名を入力してください' }, { status: 400 })
      if (!SALE_COLORS.has(color)) return NextResponse.json({ error: '表示色を確認してください' }, { status: 400 })
      const options = await loadSaleOptions()
      const sortOrder = Math.max(0, ...options.map((option) => option.sort_order || 0)) + 10
      const { data, error } = await adminClient
        .from('gw_shift_ec_sales')
        .insert({ id: crypto.randomUUID(), label, color, start_time: startTime, end_time: endTime, sort_order: sortOrder, is_active: true })
        .select('id, label, color, start_time, end_time, sort_order, is_active')
        .single()
      if (error) throw error
      return NextResponse.json({ success: true, sale: data })
    }

    if (action === 'update_sale') {
      const saleId = cleanText(body.sale_id, 80)
      const label = cleanText(body.label, 100)
      const color = cleanText(body.color, 20) as ShiftEcSaleColor
      const startTime = cleanTime(body.start_time)
      const endTime = cleanTime(body.end_time)
      if (!saleId || !label) return NextResponse.json({ error: 'ECセール名を確認してください' }, { status: 400 })
      if (!SALE_COLORS.has(color)) return NextResponse.json({ error: '表示色を確認してください' }, { status: 400 })
      const { error } = await adminClient
        .from('gw_shift_ec_sales')
        .update({ label, color, start_time: startTime, end_time: endTime, updated_at: new Date().toISOString() })
        .eq('id', saleId)
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'delete_sale' || action === 'restore_sale') {
      const saleId = cleanText(body.sale_id, 80)
      if (!saleId) return NextResponse.json({ error: 'ECセール項目を確認してください' }, { status: 400 })
      const { error } = await adminClient
        .from('gw_shift_ec_sales')
        .update({ is_active: action === 'restore_sale', updated_at: new Date().toISOString() })
        .eq('id', saleId)
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'create_pattern') {
      const rawDepartment = cleanText(body.department, 20)
      const label = cleanText(body.label, 100)
      const startTime = cleanTime(body.start_time)
      const endTime = cleanTime(body.end_time)
      const breakMinutes = Math.min(480, Math.max(0, Math.round(cleanNumber(body.break_minutes) || 0)))
      const patternRole = cleanText(body.pattern_role, 30) as ShiftPatternRole
      if (!isUserDepartment(rawDepartment)) {
        return NextResponse.json({ error: '所属を確認してください' }, { status: 400 })
      }
      if (!label) return NextResponse.json({ error: '勤務候補名を入力してください' }, { status: 400 })
      if (!SHIFT_PATTERN_ROLES.has(patternRole)) {
        return NextResponse.json({ error: '勤務候補の用途を確認してください' }, { status: 400 })
      }
      if (patternRole === 'floor_work' && rawDepartment !== 'フロア') {
        return NextResponse.json({ error: 'フロア補助勤務はフロアだけで使用できます' }, { status: 400 })
      }
      const patterns = await loadPatterns(rawDepartment)
      const sortOrder = Math.max(0, ...patterns.map((pattern) => pattern.sort_order || 0)) + 10
      const { data, error } = await adminClient
        .from('gw_shift_patterns')
        .insert({
          id: crypto.randomUUID(),
          department: rawDepartment,
          label,
          start_time: startTime,
          end_time: endTime,
          break_minutes: breakMinutes,
          work_minutes: workMinutes(startTime, endTime, breakMinutes),
          pattern_role: patternRole,
          sort_order: sortOrder,
          is_active: true,
        })
        .select('id, department, label, start_time, end_time, break_minutes, work_minutes, pattern_role, sort_order, is_active')
        .single()
      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ error: '同じ所属に同名の勤務候補があります' }, { status: 409 })
        }
        throw error
      }
      return NextResponse.json({ success: true, pattern: data })
    }

    if (action === 'update_pattern') {
      const patternId = cleanText(body.pattern_id, 80)
      const rawDepartment = cleanText(body.department, 20)
      const label = cleanText(body.label, 100)
      const startTime = cleanTime(body.start_time)
      const endTime = cleanTime(body.end_time)
      const breakMinutes = Math.min(480, Math.max(0, Math.round(cleanNumber(body.break_minutes) || 0)))
      const patternRole = cleanText(body.pattern_role, 30) as ShiftPatternRole
      if (!patternId || !isUserDepartment(rawDepartment)) {
        return NextResponse.json({ error: '勤務候補を確認してください' }, { status: 400 })
      }
      if (!label) return NextResponse.json({ error: '勤務候補名を入力してください' }, { status: 400 })
      if (!SHIFT_PATTERN_ROLES.has(patternRole)) {
        return NextResponse.json({ error: '勤務候補の用途を確認してください' }, { status: 400 })
      }
      if (patternRole === 'floor_work' && rawDepartment !== 'フロア') {
        return NextResponse.json({ error: 'フロア補助勤務はフロアだけで使用できます' }, { status: 400 })
      }

      const { data: currentPattern, error: currentError } = await adminClient
        .from('gw_shift_patterns')
        .select('id, department, label, is_active')
        .eq('id', patternId)
        .eq('department', rawDepartment)
        .maybeSingle()
      if (currentError) throw currentError
      if (!currentPattern || !currentPattern.is_active) {
        return NextResponse.json({ error: '勤務候補が見つかりません' }, { status: 404 })
      }

      const { data: updatedPattern, error } = await adminClient
        .from('gw_shift_patterns')
        .update({
          label,
          start_time: startTime,
          end_time: endTime,
          break_minutes: breakMinutes,
          work_minutes: workMinutes(startTime, endTime, breakMinutes),
          pattern_role: patternRole,
          updated_at: new Date().toISOString(),
        })
        .eq('id', patternId)
        .eq('department', rawDepartment)
        .select('id, department, label, start_time, end_time, break_minutes, work_minutes, pattern_role, sort_order, is_active')
        .single()
      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ error: '同じ所属に同名の勤務候補があります' }, { status: 409 })
        }
        throw error
      }

      if (currentPattern.label !== label) {
        const { data: preferences, error: preferenceError } = await adminClient
          .from('gw_shift_pattern_preferences')
          .select('id, employee_name, pattern_label, weight, sort_order')
          .eq('department', rawDepartment)
          .eq('pattern_label', currentPattern.label)
        if (preferenceError) throw preferenceError

        for (const preference of preferences || []) {
          const { data: duplicate, error: duplicateError } = await adminClient
            .from('gw_shift_pattern_preferences')
            .select('id, weight, sort_order')
            .eq('department', rawDepartment)
            .eq('employee_name', preference.employee_name)
            .eq('pattern_label', label)
            .neq('id', preference.id)
            .maybeSingle()
          if (duplicateError) throw duplicateError
          if (duplicate) {
            const { error: mergeError } = await adminClient
              .from('gw_shift_pattern_preferences')
              .update({
                weight: Math.max(Number(duplicate.weight || 1), Number(preference.weight || 1)),
                sort_order: Math.min(Number(duplicate.sort_order || 0), Number(preference.sort_order || 0)),
                updated_at: new Date().toISOString(),
              })
              .eq('id', duplicate.id)
            if (mergeError) throw mergeError
            const { error: deletePreferenceError } = await adminClient
              .from('gw_shift_pattern_preferences')
              .delete()
              .eq('id', preference.id)
            if (deletePreferenceError) throw deletePreferenceError
          } else {
            const { error: renamePreferenceError } = await adminClient
              .from('gw_shift_pattern_preferences')
              .update({ pattern_label: label, updated_at: new Date().toISOString() })
              .eq('id', preference.id)
            if (renamePreferenceError) throw renamePreferenceError
          }
        }
      }
      return NextResponse.json({ success: true, pattern: updatedPattern })
    }

    if (action === 'delete_pattern') {
      const patternId = cleanText(body.pattern_id, 80)
      const rawDepartment = cleanText(body.department, 20)
      if (!patternId || !isUserDepartment(rawDepartment)) {
        return NextResponse.json({ error: '勤務候補を確認してください' }, { status: 400 })
      }
      const { error } = await adminClient
        .from('gw_shift_patterns')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', patternId)
        .eq('department', rawDepartment)
      if (error) throw error
      return NextResponse.json({ success: true, pattern_id: patternId })
    }

    if (action === 'reorder_patterns') {
      const rawDepartment = cleanText(body.department, 20)
      const orderedPatternIds = Array.isArray(body.pattern_ids)
        ? body.pattern_ids.map((value) => cleanText(value, 80)).filter(Boolean)
        : []
      if (!isUserDepartment(rawDepartment) || orderedPatternIds.length === 0 || new Set(orderedPatternIds).size !== orderedPatternIds.length) {
        return NextResponse.json({ error: '勤務候補の並び順を確認してください' }, { status: 400 })
      }
      const patterns = await loadPatterns(rawDepartment)
      const activeIds = new Set(patterns.map((pattern) => pattern.id))
      if (orderedPatternIds.length !== patterns.length || orderedPatternIds.some((id) => !activeIds.has(id))) {
        return NextResponse.json({ error: '勤務候補が更新されています。画面を再読み込みしてください' }, { status: 409 })
      }
      const updates = await Promise.all(orderedPatternIds.map((id, index) => adminClient
        .from('gw_shift_patterns')
        .update({ sort_order: (index + 1) * 10, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('department', rawDepartment)))
      const updateError = updates.find((result) => result.error)?.error
      if (updateError) throw updateError
      return NextResponse.json({ success: true, pattern_ids: orderedPatternIds })
    }

    if (!periodId) return NextResponse.json({ error: 'シフト期間が必要です' }, { status: 400 })
    const period = await loadPeriod(periodId)
    if (!period) return NextResponse.json({ error: 'シフト期間が見つかりません' }, { status: 404 })

    if (action === 'apply_basic_work_time_change') {
      const userId = cleanText(body.user_id, 80)
      const effectiveFrom = cleanDate(body.effective_from)
      const previousStart = cleanTime(body.previous_start)
      const previousEnd = cleanTime(body.previous_end)
      const nextStart = cleanTime(body.next_start)
      const nextEnd = cleanTime(body.next_end)
      const breakMinutes = Math.min(480, Math.max(0, Math.round(cleanNumber(body.break_minutes) || 0)))

      if (!userId || !effectiveFrom || !previousStart || !previousEnd || !nextStart || !nextEnd) {
        return NextResponse.json({ error: '基本勤務の変更内容を確認してください' }, { status: 400 })
      }
      if (period.department !== '製造') {
        return NextResponse.json({ error: 'この更新は製造シフトでのみ実行できます' }, { status: 400 })
      }

      const employee = (await loadShiftEmployees(period.department)).find((row) => row.user_id === userId)
      if (!employee) return NextResponse.json({ error: '対象スタッフが製造の在籍者に見つかりません' }, { status: 404 })

      const { data: employeeRow, error: employeeError } = await adminClient
        .from('gw_payroll_employees')
        .select('id, user_id, employee_code, display_name, real_name, raw_payload')
        .eq('user_id', userId)
        .maybeSingle()
      if (employeeError) throw employeeError
      if (!employeeRow) return NextResponse.json({ error: '人事情報が見つかりません' }, { status: 404 })

      const rawPayload = employeeRow.raw_payload && typeof employeeRow.raw_payload === 'object' && !Array.isArray(employeeRow.raw_payload)
        ? employeeRow.raw_payload as Record<string, unknown>
        : {}
      const currentProfile = hrProfile(rawPayload)
      const currentStart = cleanTime(currentProfile.basic_work_start)
      const currentEnd = cleanTime(currentProfile.basic_work_end)
      const currentBreak = Number(currentProfile.basic_break_minutes || 0)
      const alreadyUpdated = currentStart === nextStart && currentEnd === nextEnd && currentBreak === breakMinutes
      const matchesPrevious = currentStart === previousStart && currentEnd === previousEnd && currentBreak === breakMinutes
      if (!alreadyUpdated && !matchesPrevious) {
        return NextResponse.json({
          error: `現在の基本勤務（${currentStart || '-'}-${currentEnd || '-'} / 休憩${currentBreak}分）が想定と異なるため更新を中止しました`,
        }, { status: 409 })
      }

      const { data: periods, error: periodsError } = await adminClient
        .from('gw_shift_periods')
        .select('id, department, start_date, end_date, status')
        .eq('department', period.department)
        .gte('end_date', effectiveFrom)
      if (periodsError) throw periodsError
      const periodIds = (periods || []).map((row) => String(row.id))

      const assignmentResult = periodIds.length > 0
        ? await adminClient
          .from('gw_shift_assignments')
          .select('id, work_date, start_time, end_time, break_minutes, work_minutes, shift_label, assignment_type')
          .in('period_id', periodIds)
          .eq('user_id', userId)
          .gte('work_date', effectiveFrom)
        : { data: [], error: null }
      if (assignmentResult.error) throw assignmentResult.error

      const targetAssignments = (assignmentResult.data || []).filter((assignment) => (
        assignment.assignment_type === 'staff' &&
        cleanTime(assignment.start_time) === previousStart &&
        cleanTime(assignment.end_time) === previousEnd &&
        Number(assignment.break_minutes || 0) === breakMinutes
      ))

      if (!alreadyUpdated) {
        const extendedProfile = currentProfile as Record<string, unknown>
        const history = Array.isArray(extendedProfile.basic_work_change_history)
          ? extendedProfile.basic_work_change_history as unknown[]
          : []
        const nextProfile = {
          ...currentProfile,
          basic_work_start: nextStart,
          basic_work_end: nextEnd,
          basic_break_minutes: breakMinutes,
          basic_work_effective_from: effectiveFrom,
          basic_work_change_history: [
            ...history,
            {
              effective_from: effectiveFrom,
              previous_start: previousStart,
              previous_end: previousEnd,
              next_start: nextStart,
              next_end: nextEnd,
              break_minutes: breakMinutes,
              changed_at: new Date().toISOString(),
              changed_by: auth.user!.id,
            },
          ],
        }
        const { error: profileError } = await adminClient
          .from('gw_payroll_employees')
          .update({
            raw_payload: { ...rawPayload, hr_profile: nextProfile },
            updated_at: new Date().toISOString(),
          })
          .eq('id', employeeRow.id)
        if (profileError) throw profileError
      }

      if (targetAssignments.length > 0) {
        const { error: assignmentError } = await adminClient
          .from('gw_shift_assignments')
          .update({
            pattern_id: null,
            shift_label: `${nextStart}-${nextEnd}`,
            start_time: nextStart,
            end_time: nextEnd,
            break_minutes: breakMinutes,
            work_minutes: workMinutes(nextStart, nextEnd, breakMinutes),
            source: 'manual',
            updated_by: auth.user!.id,
            updated_at: new Date().toISOString(),
          })
          .in('id', targetAssignments.map((assignment) => assignment.id))
        if (assignmentError) throw assignmentError
      }

      return NextResponse.json({
        success: true,
        employee: displayName(employee),
        employee_code: employeeRow.employee_code,
        already_updated: alreadyUpdated,
        effective_from: effectiveFrom,
        previous: { start_time: previousStart, end_time: previousEnd, break_minutes: breakMinutes },
        next: { start_time: nextStart, end_time: nextEnd, break_minutes: breakMinutes },
        updated_assignments: targetAssignments.length,
        updated_dates: targetAssignments.map((assignment) => assignment.work_date).sort(),
      })
    }

    if (action === 'update_confirmed_notes') {
      if (period.status !== 'confirmed') {
        return NextResponse.json({ error: '備考修正は確定保存済みのシフトでのみ実行できます' }, { status: 409 })
      }
      const rawRequirements = recordList(body.requirements)
      const periodDates = new Set(eachDate(period.start_date, period.end_date))
      if (rawRequirements.length === 0 || rawRequirements.length > periodDates.size) {
        return NextResponse.json({ error: '修正する備考を確認してください' }, { status: 400 })
      }
      const seenDates = new Set<string>()
      const noteRows: Array<{
        period_id: string
        work_date: string
        notes: string | null
        notes2: string | null
        production_plan: string | null
        updated_at: string
      }> = []
      const now = new Date().toISOString()
      for (const rawRequirement of rawRequirements) {
        const workDate = cleanDate(rawRequirement.work_date)
        if (!workDate || !periodDates.has(workDate) || seenDates.has(workDate)) {
          return NextResponse.json({ error: '備考の日付が不正です' }, { status: 400 })
        }
        seenDates.add(workDate)
        noteRows.push({
          period_id: period.id,
          work_date: workDate,
          notes: cleanText(rawRequirement.notes, 300) || null,
          notes2: cleanText(rawRequirement.notes2, 300) || null,
          production_plan: cleanText(rawRequirement.production_plan, 500) || null,
          updated_at: now,
        })
      }
      const { data: updatedRows, error: updateNotesError } = await adminClient
        .from('gw_shift_requirements')
        .upsert(noteRows, { onConflict: 'period_id,work_date' })
        .select('id')
      if (updateNotesError) throw updateNotesError
      return NextResponse.json({ success: true, updated: updatedRows?.length || 0 })
    }

    if (action === 'delete_period') {
      const { data: deletedPeriods, error } = await adminClient
        .from('gw_shift_periods')
        .delete()
        .eq('id', period.id)
        .select('id')
      if (error) throw error
      if (!deletedPeriods?.length) {
        return NextResponse.json({ error: 'シフト期間は既に削除されています。画面を再読み込みしてください' }, { status: 409 })
      }
      return NextResponse.json({
        success: true,
        deleted: true,
        deleted_count: deletedPeriods.length,
        deleted_period_id: period.id,
      })
    }

    if (LOCKED_STATUSES.has(period.status)) {
      return NextResponse.json({ error: '確定保存済みのシフトは変更できません' }, { status: 409 })
    }

    if (action === 'reorder_employees') {
      const orderedUserIds = Array.isArray(body.user_ids)
        ? body.user_ids.map((value) => cleanText(value, 80)).filter(Boolean)
        : []
      if (orderedUserIds.length < 2 || new Set(orderedUserIds).size !== orderedUserIds.length) {
        return NextResponse.json({ error: 'スタッフの並び順を確認してください' }, { status: 400 })
      }

      const [allEmployees, excludedUserIds] = await Promise.all([
        loadShiftEmployees(period.department),
        loadExcludedUserIds(period.id),
      ])
      const visibleEmployees = allEmployees.filter((employee) => !excludedUserIds.has(employee.user_id))
      const visibleUserIds = new Set(visibleEmployees.map((employee) => employee.user_id))
      if (orderedUserIds.length !== visibleEmployees.length || orderedUserIds.some((userId) => !visibleUserIds.has(userId))) {
        return NextResponse.json({ error: '表示中のスタッフ一覧が更新されています。画面を再読み込みしてください' }, { status: 409 })
      }

      const completeOrder = [
        ...orderedUserIds,
        ...allEmployees.filter((employee) => excludedUserIds.has(employee.user_id)).map((employee) => employee.user_id),
      ]
      const { data: employeeRows, error: employeesError } = await adminClient
        .from('gw_payroll_employees')
        .select('id, user_id, raw_payload')
        .in('user_id', completeOrder)
      if (employeesError) throw employeesError

      const rowByUserId = new Map((employeeRows || []).map((row) => [String(row.user_id || ''), row]))
      const now = new Date().toISOString()
      const updates = await Promise.all(completeOrder.map((userId, index) => {
        const row = rowByUserId.get(userId)
        if (!row) return Promise.resolve({ error: new Error('スタッフ情報が見つかりません') })
        const rawPayload = row.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)
          ? row.raw_payload as Record<string, unknown>
          : {}
        const currentProfile = rawPayload.hr_profile && typeof rawPayload.hr_profile === 'object' && !Array.isArray(rawPayload.hr_profile)
          ? rawPayload.hr_profile as Record<string, unknown>
          : {}
        return adminClient
          .from('gw_payroll_employees')
          .update({
            raw_payload: {
              ...rawPayload,
              hr_profile: {
                ...currentProfile,
                shift_sort_order: (index + 1) * 10,
              },
            },
            updated_at: now,
          })
          .eq('id', row.id)
      }))
      const updateError = updates.find((result) => result.error)?.error
      if (updateError) throw updateError

      return NextResponse.json({ success: true, employees: orderedUserIds.length })
    }

    if (action === 'reset_shift') {
      const [deleteAssignments, resetPeriod] = await Promise.all([
        adminClient
          .from('gw_shift_assignments')
          .delete({ count: 'exact' })
          .eq('period_id', period.id),
        adminClient
          .from('gw_shift_periods')
          .update({ status: 'draft', updated_at: new Date().toISOString() })
          .eq('id', period.id),
      ])
      const dbError = deleteAssignments.error || resetPeriod.error
      if (dbError) throw dbError
      return NextResponse.json({ success: true, deletedAssignments: deleteAssignments.count || 0 })
    }

    if (action === 'save_shift_changes') {
      const finalize = body.finalize === true
      if (finalize && period.is_test_mode) {
        return NextResponse.json({ error: '希望回収テスト中はシフトを確定保存できません' }, { status: 400 })
      }
      if (finalize) {
        const { data: overlappingPeriods, error: overlapError } = await adminClient
          .from('gw_shift_periods')
          .select('id, title, start_date, end_date')
          .eq('department', period.department)
          .eq('is_test_mode', false)
          .in('status', ['confirmed', 'exported', 'archived'])
          .neq('id', period.id)
          .lte('start_date', period.end_date)
          .gte('end_date', period.start_date)
          .limit(1)
        if (overlapError) throw overlapError
        if (overlappingPeriods?.length) {
          const conflict = overlappingPeriods[0]
          return NextResponse.json({
            error: `確定済みの「${conflict.title}」（${conflict.start_date}〜${conflict.end_date}）と期間が重複しています`,
          }, { status: 409 })
        }
      }

      const rawRequirements = recordList(body.requirements)
      const rawAssignments = recordList(body.assignments)
      const rawRequestChanges = recordList(body.request_changes)
      const rawCellStyles = recordList(body.cell_styles)
      const periodDates = new Set(eachDate(period.start_date, period.end_date))

      if (rawRequirements.length > periodDates.size || rawAssignments.length > periodDates.size * 200 || rawRequestChanges.length > periodDates.size * 200 || rawCellStyles.length > periodDates.size * 205) {
        return NextResponse.json({ error: '保存するシフトデータの件数を確認してください' }, { status: 400 })
      }

      const [patterns, employees, blockingRequestsResult, exclusionsResult, existingAssignmentsResult, existingCellStylesResult] = await Promise.all([
        loadPatterns(period.department),
        loadShiftEmployees(period.department),
        adminClient
          .from('gw_shift_requests')
          .select('user_id, work_date, request_type')
          .eq('period_id', period.id)
          .in('request_type', ['day_off', 'unavailable', 'paid_leave_full']),
        adminClient
          .from('gw_shift_period_exclusions')
          .select('user_id')
          .eq('period_id', period.id),
        adminClient
          .from('gw_shift_assignments')
          .select('id, user_id, work_date')
          .eq('period_id', period.id),
        adminClient
          .from('gw_shift_cell_styles')
          .select('id, work_date, cell_key')
          .eq('period_id', period.id),
      ])
      if (blockingRequestsResult.error) throw blockingRequestsResult.error
      if (exclusionsResult.error) throw exclusionsResult.error
      if (existingAssignmentsResult.error) throw existingAssignmentsResult.error
      if (existingCellStylesResult.error) throw existingCellStylesResult.error

      const excludedUserIds = new Set((exclusionsResult.data || []).map((row) => String(row.user_id || '')))
      const employeeByUserId = new Map(employees
        .filter((employee) => !excludedUserIds.has(employee.user_id))
        .map((employee) => [employee.user_id, employee]))
      const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]))
      const patternByLabel = new Map(patterns.map((pattern) => [pattern.label, pattern]))
      const blockingKeys = new Set((blockingRequestsResult.data || []).map((row) => `${row.user_id}:${row.work_date}`))
      const requestChanges: Array<Record<string, unknown> & { user_id: string; work_date: string; request_type: string }> = []
      const requestChangeKeys = new Set<string>()

      for (const requestChange of rawRequestChanges) {
        const userId = cleanText(requestChange.user_id, 80)
        const workDate = cleanDate(requestChange.work_date)
        const requestType = cleanText(requestChange.request_type, 40)
        const employee = employeeByUserId.get(userId)
        const key = `${userId}:${workDate}`
        if (!employee || !workDate || !periodDates.has(workDate) || requestChangeKeys.has(key)) {
          return NextResponse.json({ error: '保存する休み設定を確認してください' }, { status: 400 })
        }
        if (requestType && !REQUEST_TYPES.has(requestType as ShiftRequestType)) {
          return NextResponse.json({ error: '保存する希望種別を確認してください' }, { status: 400 })
        }
        requestChangeKeys.add(key)
        blockingKeys.delete(key)
        if (requestType === 'day_off' || requestType === 'unavailable' || requestType === 'paid_leave_full') blockingKeys.add(key)
        requestChanges.push({
          ...requestChange,
          user_id: userId,
          employee_id: employee.id,
          work_date: workDate,
          request_type: requestType,
        })
      }

      const requirementRows: Record<string, unknown>[] = []
      const requirementDates = new Set<string>()
      for (const requirement of rawRequirements) {
        const workDate = cleanDate(requirement.work_date)
        if (!workDate || !periodDates.has(workDate) || requirementDates.has(workDate)) {
          return NextResponse.json({ error: '保存する日別条件を確認してください' }, { status: 400 })
        }
        requirementDates.add(workDate)
        requirementRows.push(requirementPayload(requirement, period.id, workDate, period.department))
      }

      const assignmentRows: Record<string, unknown>[] = []
      const assignmentKeys = new Set<string>()
      for (const assignment of rawAssignments) {
        const userId = cleanText(assignment.user_id, 80)
        const workDate = cleanDate(assignment.work_date)
        const shiftLabel = cleanText(assignment.shift_label, 120)
        const isCompanyOff = !shiftLabel && cleanText(assignment.note, 80) === SHIFT_COMPANY_OFF_NOTE
        if (!shiftLabel && !isCompanyOff) continue
        const employee = employeeByUserId.get(userId)
        const key = `${userId}:${workDate}`
        if (!employee || !workDate || !periodDates.has(workDate) || assignmentKeys.has(key)) {
          return NextResponse.json({ error: '保存するスタッフ割当を確認してください' }, { status: 400 })
        }
        if (employee.hire_date && workDate < employee.hire_date) {
          return NextResponse.json({ error: `${displayName(employee)}は${employee.hire_date}入社予定のため、入社日前へ勤務を保存できません` }, { status: 400 })
        }
        if (blockingKeys.has(key) && !isCompanyOff) {
          return NextResponse.json({ error: `${displayName(employee)} ${workDate} は休み希望のため勤務を保存できません` }, { status: 400 })
        }
        if (blockingKeys.has(key) && isCompanyOff) continue
        const patternId = cleanText(assignment.pattern_id, 80)
        const pattern = patternById.get(patternId) || patternByLabel.get(shiftLabel) || null
        if (pattern && isBasicShiftPattern(pattern) && !isRegularEmployee(employee)) {
          return NextResponse.json({ error: `${displayName(employee)}は基本勤務を選択できません` }, { status: 400 })
        }
        assignmentKeys.add(key)
        assignmentRows.push(assignmentPayload({
          body: {
            ...assignment,
            user_id: userId,
            employee_id: employee.id,
            shift_label: shiftLabel,
            note: isCompanyOff ? SHIFT_COMPANY_OFF_NOTE : assignment.note,
          },
          periodId: period.id,
          workDate,
          pattern,
          employee,
          actorId: auth.user!.id,
          employeeId: employee.id,
        }))
      }

      const cellStyleRows: Record<string, unknown>[] = []
      const cellStyleKeys = new Set<string>()
      for (const cellStyle of rawCellStyles) {
        const workDate = cleanDate(cellStyle.work_date)
        const cellKey = cleanText(cellStyle.cell_key, 140)
        const backgroundColor = cleanText(cellStyle.background_color, 20).toLowerCase()
        const key = `${workDate}:${cellKey}`
        const validColor = HEX_COLOR_PATTERN.test(backgroundColor)
        if (!workDate || !periodDates.has(workDate) || !/^(date|weekday|required|timee|notes|notes2|user:[a-zA-Z0-9-]+)$/.test(cellKey) || !validColor || cellStyleKeys.has(key)) {
          return NextResponse.json({ error: '保存するセル色を確認してください' }, { status: 400 })
        }
        cellStyleKeys.add(key)
        cellStyleRows.push({
          period_id: period.id,
          work_date: workDate,
          cell_key: cellKey,
          background_color: backgroundColor,
          updated_by: auth.user!.id,
          updated_at: new Date().toISOString(),
        })
      }

      if (requirementRows.length > 0) {
        const { error } = await adminClient
          .from('gw_shift_requirements')
          .upsert(requirementRows, { onConflict: 'period_id,work_date' })
        if (error) throw error
      }

      for (const requestChange of requestChanges) {
        if (requestChange.request_type) {
          const { error: upsertError } = await adminClient
            .from('gw_shift_requests')
            .upsert({
              period_id: period.id,
              user_id: requestChange.user_id,
              employee_id: requestChange.employee_id,
              work_date: requestChange.work_date,
              request_type: requestChange.request_type,
              priority: ['prefer', 'ok'].includes(cleanText(requestChange.priority, 20)) ? cleanText(requestChange.priority, 20) : 'must',
              start_time: cleanTime(requestChange.start_time),
              end_time: cleanTime(requestChange.end_time),
              memo: cleanText(requestChange.memo, 300) || null,
              status: 'submitted',
              is_test: period.is_test_mode,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'period_id,user_id,work_date' })
          if (upsertError) throw upsertError
        } else {
          const { error: deleteError } = await adminClient
            .from('gw_shift_requests')
            .delete()
            .eq('period_id', period.id)
            .eq('user_id', requestChange.user_id)
            .eq('work_date', requestChange.work_date)
          if (deleteError) throw deleteError
        }
      }

      if (assignmentRows.length > 0) {
        const { error } = await adminClient
          .from('gw_shift_assignments')
          .upsert(assignmentRows, { onConflict: 'period_id,user_id,work_date' })
        if (error) throw error
      }
      const staleAssignmentIds = (existingAssignmentsResult.data || [])
        .filter((row) => !assignmentKeys.has(`${row.user_id}:${row.work_date}`))
        .map((row) => row.id)
      for (let index = 0; index < staleAssignmentIds.length; index += 200) {
        const { error } = await adminClient
          .from('gw_shift_assignments')
          .delete()
          .in('id', staleAssignmentIds.slice(index, index + 200))
        if (error) throw error
      }

      if (cellStyleRows.length > 0) {
        const { error } = await adminClient
          .from('gw_shift_cell_styles')
          .upsert(cellStyleRows, { onConflict: 'period_id,work_date,cell_key' })
        if (error) throw error
      }
      const staleCellStyleIds = (existingCellStylesResult.data || [])
        .filter((row) => !cellStyleKeys.has(`${row.work_date}:${row.cell_key}`))
        .map((row) => row.id)
      for (let index = 0; index < staleCellStyleIds.length; index += 200) {
        const { error } = await adminClient
          .from('gw_shift_cell_styles')
          .delete()
          .in('id', staleCellStyleIds.slice(index, index + 200))
        if (error) throw error
      }

      const now = new Date().toISOString()
      let paidLeaveRequests = 0
      if (finalize) {
        const paidLeaveSync = await syncShiftPaidLeaveRequests(period.id, auth.user!.id)
        paidLeaveRequests = paidLeaveSync.synced
      }
      const periodUpdates: Record<string, unknown> = {
        status: finalize ? 'confirmed' : 'editing',
        updated_at: now,
      }
      if (finalize) {
        periodUpdates.confirmed_by = auth.user!.id
        periodUpdates.confirmed_at = now
      }
      const { error: periodUpdateError } = await adminClient
        .from('gw_shift_periods')
        .update(periodUpdates)
        .eq('id', period.id)
      if (periodUpdateError) throw periodUpdateError

      let confirmationAlerts = 0
      if (finalize) {
        const { count, error: confirmationAlertError } = await adminClient
          .from('gw_shift_confirmation_alerts')
          .select('id', { count: 'exact', head: true })
          .eq('period_id', period.id)
        if (confirmationAlertError) throw confirmationAlertError
        confirmationAlerts = count || 0
      }

      return NextResponse.json({
        success: true,
        finalized: finalize,
        requirements: requirementRows.length,
        assignments: assignmentRows.length,
        requestChanges: requestChanges.length,
        paidLeaveRequests,
        cellStyles: cellStyleRows.length,
        confirmationAlerts,
      })
    }

    if (action === 'update_period') {
      const status = cleanText(body.status, 30) as ShiftStatus
      if (status === 'confirmed') {
        return NextResponse.json({
          error: 'シフト確定は「確定保存」から実行してください。有給同期を伴わない状態変更はできません',
        }, { status: 400 })
      }
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (STATUSES.has(status)) updates.status = status
      if (body.title !== undefined) updates.title = cleanText(body.title, 120) || period.title
      if (body.request_deadline !== undefined) updates.request_deadline = cleanDate(body.request_deadline) || null
      if (body.notes !== undefined) updates.notes = cleanText(body.notes, 500) || null
      const { error } = await adminClient
        .from('gw_shift_periods')
        .update(updates)
        .eq('id', period.id)
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'start_test_collection') {
      if (['confirmed', 'exported', 'archived'].includes(period.status)) {
        return NextResponse.json({ error: '確定済みのシフト期間では希望回収テストを実行できません' }, { status: 400 })
      }

      const [realRequestsResult, realSubmissionsResult, targetsResult] = await Promise.all([
        adminClient
          .from('gw_shift_requests')
          .select('id', { count: 'exact', head: true })
          .eq('period_id', period.id)
          .eq('is_test', false),
        adminClient
          .from('gw_shift_request_submissions')
          .select('id', { count: 'exact', head: true })
          .eq('period_id', period.id)
          .eq('is_test', false),
        adminClient
          .from('gw_shift_request_targets')
          .select('id', { count: 'exact', head: true })
          .eq('period_id', period.id),
      ])
      const checkError = realRequestsResult.error || realSubmissionsResult.error || targetsResult.error
      if (checkError) throw checkError
      if ((realRequestsResult.count || 0) > 0 || (realSubmissionsResult.count || 0) > 0) {
        return NextResponse.json({ error: '実際の希望回収データがあるためテストを開始できません。別のシフト期間で実行してください。' }, { status: 400 })
      }

      if (!period.is_test_mode && (targetsResult.count || 0) > 0) {
        return NextResponse.json({ error: '通常の希望回収中です。テストは別のシフト期間で実行してください。' }, { status: 400 })
      }

      const [employees, excludedUserIds] = await Promise.all([
        loadShiftEmployees(period.department),
        loadExcludedUserIds(period.id),
      ])
      const testEmployees = employees.filter((employee) => (
        !excludedUserIds.has(employee.user_id) && !employee.request_collection_excluded
      ))
      if (testEmployees.length === 0) {
        return NextResponse.json({ error: 'テスト希望を作成できるスタッフがいません' }, { status: 400 })
      }

      const testData = buildRandomShiftTestData(period, testEmployees)
      const now = new Date().toISOString()

      const cleanupResults = await Promise.all([
        adminClient.from('gw_shift_requests').delete().eq('period_id', period.id).eq('is_test', true),
        adminClient.from('gw_shift_request_submissions').delete().eq('period_id', period.id).eq('is_test', true),
        adminClient.from('gw_shift_request_targets').delete().eq('period_id', period.id),
        adminClient.from('gw_shift_assignments').delete().eq('period_id', period.id).eq('source', 'ai'),
      ])
      const cleanupError = cleanupResults.find((result) => result.error)?.error
      if (cleanupError) throw cleanupError

      const insertResults = await Promise.all([
        testData.requests.length > 0
          ? adminClient.from('gw_shift_requests').insert(testData.requests)
          : Promise.resolve({ error: null }),
        adminClient
          .from('gw_shift_request_submissions')
          .upsert(testData.submissions, { onConflict: 'period_id,user_id' }),
        adminClient
          .from('gw_shift_periods')
          .update({ status: 'collecting', is_test_mode: true, updated_at: now })
          .eq('id', period.id),
      ])
      const insertError = insertResults.find((result) => result.error)?.error
      if (insertError) throw insertError

      return NextResponse.json({
        success: true,
        staff: testEmployees.length,
        requests: testData.requests.length,
      })
    }

    if (action === 'start_collection') {
      const userIds = Array.isArray(body.target_user_ids)
        ? [...new Set(body.target_user_ids.map((item) => cleanText(item, 80)).filter(Boolean))]
        : []
      if (userIds.length === 0) return NextResponse.json({ error: '希望回収対象を選択してください' }, { status: 400 })

      const [employees, excludedUserIds] = await Promise.all([
        loadShiftEmployees(period.department),
        loadExcludedUserIds(period.id),
      ])
      const employeeMap = new Map(employees.map((employee) => [employee.user_id, employee]))
      const validUserIds = userIds.filter((userId) => {
        const employee = employeeMap.get(userId)
        return employee && !excludedUserIds.has(userId) && !employee.request_collection_excluded
      })
      if (validUserIds.length === 0) return NextResponse.json({ error: '対象スタッフが見つかりません' }, { status: 400 })

      const targetRows = validUserIds.map((userId) => ({
        period_id: period.id,
        user_id: userId,
        employee_id: employeeMap.get(userId)?.id || null,
        requested_by: auth.user!.id,
        requested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))

      const deleteOldTargets = await adminClient
        .from('gw_shift_request_targets')
        .delete()
        .eq('period_id', period.id)
      if (deleteOldTargets.error) throw deleteOldTargets.error

      if (period.is_test_mode) {
        const cleanupResults = await Promise.all([
          adminClient.from('gw_shift_requests').delete().eq('period_id', period.id).eq('is_test', true),
          adminClient.from('gw_shift_request_submissions').delete().eq('period_id', period.id).eq('is_test', true),
          adminClient.from('gw_shift_assignments').delete().eq('period_id', period.id).eq('source', 'ai'),
        ])
        const cleanupError = cleanupResults.find((result) => result.error)?.error
        if (cleanupError) throw cleanupError
      }

      const [upsertTargets, updatePeriod] = await Promise.all([
        adminClient
          .from('gw_shift_request_targets')
          .upsert(targetRows, { onConflict: 'period_id,user_id' }),
        adminClient
          .from('gw_shift_periods')
          .update({ status: 'collecting', is_test_mode: false, updated_at: new Date().toISOString() })
          .eq('id', period.id),
      ])
      const dbError = upsertTargets.error || updatePeriod.error
      if (dbError) throw dbError
      return NextResponse.json({ success: true, targets: validUserIds.length })
    }

    if (action === 'remove_period_employee') {
      const userId = cleanText(body.user_id, 80)
      if (!userId) return NextResponse.json({ error: '対象スタッフを確認してください' }, { status: 400 })

      const employee = (await loadShiftEmployees(period.department))
        .find((item) => item.user_id === userId)
      if (!employee) return NextResponse.json({ error: '対象スタッフが見つかりません' }, { status: 404 })

      const { error: exclusionError } = await adminClient
        .from('gw_shift_period_exclusions')
        .upsert({
          period_id: period.id,
          user_id: userId,
          employee_id: employee.id,
          excluded_by: auth.user!.id,
          excluded_at: new Date().toISOString(),
        }, { onConflict: 'period_id,user_id' })
      if (exclusionError) throw exclusionError

      const cleanupResults = await Promise.all([
        adminClient.from('gw_shift_assignments').delete({ count: 'exact' }).eq('period_id', period.id).eq('user_id', userId),
        adminClient.from('gw_shift_requests').delete({ count: 'exact' }).eq('period_id', period.id).eq('user_id', userId),
        adminClient.from('gw_shift_request_submissions').delete({ count: 'exact' }).eq('period_id', period.id).eq('user_id', userId),
        adminClient.from('gw_shift_request_targets').delete({ count: 'exact' }).eq('period_id', period.id).eq('user_id', userId),
        adminClient.from('gw_shift_cell_styles').delete().eq('period_id', period.id).eq('cell_key', `user:${userId}`),
        adminClient.from('gw_shift_periods').update({ updated_at: new Date().toISOString() }).eq('id', period.id),
      ])
      const cleanupError = cleanupResults.find((result) => result.error)?.error
      if (cleanupError) throw cleanupError

      return NextResponse.json({
        success: true,
        removed: true,
        deletedAssignments: cleanupResults[0].count || 0,
        deletedRequests: cleanupResults[1].count || 0,
      })
    }

    if (action === 'restore_period_employee') {
      const userId = cleanText(body.user_id, 80)
      if (!userId) return NextResponse.json({ error: '対象スタッフを確認してください' }, { status: 400 })

      const { error } = await adminClient
        .from('gw_shift_period_exclusions')
        .delete()
        .eq('period_id', period.id)
        .eq('user_id', userId)
      if (error) throw error

      await adminClient
        .from('gw_shift_periods')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', period.id)

      return NextResponse.json({ success: true, restored: true })
    }

    if (action === 'bulk_clear_assignments') {
      const { count, error } = await adminClient
        .from('gw_shift_assignments')
        .delete({ count: 'exact' })
        .eq('period_id', period.id)
      if (error) throw error
      return NextResponse.json({ success: true, deleted: count || 0 })
    }

    if (action === 'clear_requests') {
      const [requestsDelete, submissionsDelete, targetsDelete] = await Promise.all([
        adminClient
          .from('gw_shift_requests')
          .delete({ count: 'exact' })
          .eq('period_id', period.id),
        adminClient
          .from('gw_shift_request_submissions')
          .delete({ count: 'exact' })
          .eq('period_id', period.id),
        adminClient
          .from('gw_shift_request_targets')
          .delete({ count: 'exact' })
          .eq('period_id', period.id),
      ])
      const dbError = requestsDelete.error || submissionsDelete.error || targetsDelete.error
      if (dbError) throw dbError
      if (period.is_test_mode) {
        const { error } = await adminClient
          .from('gw_shift_assignments')
          .delete()
          .eq('period_id', period.id)
          .eq('source', 'ai')
        if (error) throw error
      }
      if (period.status === 'collecting' || period.is_test_mode) {
        const { error } = await adminClient
          .from('gw_shift_periods')
          .update({
            status: period.is_test_mode ? 'draft' : 'generated',
            is_test_mode: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', period.id)
        if (error) throw error
      }
      return NextResponse.json({
        success: true,
        deletedRequests: requestsDelete.count || 0,
        deletedSubmissions: submissionsDelete.count || 0,
        deletedTargets: targetsDelete.count || 0,
      })
    }

    if (action === 'save_requirement') {
      const workDate = cleanDate(body.work_date)
      if (!workDate || workDate < period.start_date || workDate > period.end_date) {
        return NextResponse.json({ error: '対象日を確認してください' }, { status: 400 })
      }

      const { error } = await adminClient
        .from('gw_shift_requirements')
        .upsert(requirementPayload(body, period.id, workDate, period.department), { onConflict: 'period_id,work_date' })
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'save_cell_color') {
      const workDate = cleanDate(body.work_date)
      const cellKey = cleanText(body.cell_key, 140)
      const backgroundColor = cleanText(body.background_color, 20).toLowerCase()
      if (!workDate || workDate < period.start_date || workDate > period.end_date || !/^(date|weekday|required|timee|notes|notes2|user:[a-zA-Z0-9-]+)$/.test(cellKey)) {
        return NextResponse.json({ error: '色を変更するマスを確認してください' }, { status: 400 })
      }

      if (!backgroundColor) {
        const { error } = await adminClient
          .from('gw_shift_cell_styles')
          .delete()
          .eq('period_id', period.id)
          .eq('work_date', workDate)
          .eq('cell_key', cellKey)
        if (error) throw error
        return NextResponse.json({ success: true, deleted: true })
      }
      const validColor = HEX_COLOR_PATTERN.test(backgroundColor)
      if (!validColor) {
        return NextResponse.json({ error: '使用できない色です' }, { status: 400 })
      }
      const { error } = await adminClient
        .from('gw_shift_cell_styles')
        .upsert({
          period_id: period.id,
          work_date: workDate,
          cell_key: cellKey,
          background_color: backgroundColor,
          updated_by: auth.user!.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'period_id,work_date,cell_key' })
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'save_request') {
      const workDate = cleanDate(body.work_date)
      const userId = cleanText(body.user_id, 80)
      const requestType = cleanText(body.request_type, 40) as ShiftRequestType | ''
      if (!workDate || workDate < period.start_date || workDate > period.end_date || !userId) {
        return NextResponse.json({ error: 'スタッフと対象日を確認してください' }, { status: 400 })
      }
      if (period.status === 'archived') {
        return NextResponse.json({ error: '保管済みシフトは修正できません' }, { status: 400 })
      }

      const employees = await loadShiftEmployees(period.department)
      const employee = employees.find((item) => item.user_id === userId)
      if (!employee) return NextResponse.json({ error: '対象スタッフが見つかりません' }, { status: 404 })

      if (!requestType) {
        const { error } = await adminClient
          .from('gw_shift_requests')
          .delete()
          .eq('period_id', period.id)
          .eq('work_date', workDate)
          .eq('user_id', userId)
        if (error) throw error
        return NextResponse.json({ success: true, deleted: true })
      }
      if (!REQUEST_TYPES.has(requestType)) {
        return NextResponse.json({ error: '希望種別を確認してください' }, { status: 400 })
      }

      const priority = cleanText(body.priority, 20)
      const { error: upsertError } = await adminClient
        .from('gw_shift_requests')
        .upsert({
          period_id: period.id,
          user_id: userId,
          employee_id: employee.id,
          work_date: workDate,
          request_type: requestType,
          priority: priority === 'prefer' || priority === 'ok' ? priority : 'must',
          start_time: cleanTime(body.start_time),
          end_time: cleanTime(body.end_time),
          memo: cleanText(body.memo, 300) || null,
          status: 'submitted',
          is_test: period.is_test_mode,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'period_id,user_id,work_date' })
      if (upsertError) throw upsertError

      if (requestType === 'day_off' || requestType === 'unavailable' || requestType === 'paid_leave_full') {
        const { error: assignmentDeleteError } = await adminClient
          .from('gw_shift_assignments')
          .delete()
          .eq('period_id', period.id)
          .eq('work_date', workDate)
          .eq('user_id', userId)
        if (assignmentDeleteError) throw assignmentDeleteError
      }

      return NextResponse.json({ success: true })
    }

    if (action === 'save_assignment') {
      const workDate = cleanDate(body.work_date)
      const userId = cleanText(body.user_id, 80)
      const shiftLabel = cleanText(body.shift_label, 120)
      if (!workDate || workDate < period.start_date || workDate > period.end_date || !userId) {
        return NextResponse.json({ error: 'スタッフと対象日を確認してください' }, { status: 400 })
      }

      if (!shiftLabel) {
        const { error } = await adminClient
          .from('gw_shift_assignments')
          .delete()
          .eq('period_id', period.id)
          .eq('work_date', workDate)
          .eq('user_id', userId)
        if (error) throw error
        return NextResponse.json({ success: true, deleted: true })
      }

      const { data: blockingRequest, error: blockingError } = await adminClient
        .from('gw_shift_requests')
        .select('id, request_type')
        .eq('period_id', period.id)
        .eq('work_date', workDate)
        .eq('user_id', userId)
        .in('request_type', ['day_off', 'unavailable', 'paid_leave_full'])
        .maybeSingle()
      if (blockingError) throw blockingError
      if (blockingRequest) {
        return NextResponse.json({ error: '休み希望/出勤不可の日にはシフトを入れられません' }, { status: 400 })
      }

      const [patterns, employees] = await Promise.all([
        loadPatterns(period.department),
        loadShiftEmployees(period.department),
      ])
      const patternId = cleanText(body.pattern_id, 80)
      const pattern = patterns.find((item) => item.id === patternId) ||
        patterns.find((item) => item.label === shiftLabel) ||
        null
      const employee = employees.find((item) => item.user_id === userId)
      if (!employee) return NextResponse.json({ error: '対象スタッフが見つかりません' }, { status: 404 })
      if (employee.hire_date && workDate < employee.hire_date) {
        return NextResponse.json({ error: `${displayName(employee)}は${employee.hire_date}入社予定のため、入社日前へ勤務を保存できません` }, { status: 400 })
      }
      if (pattern && isBasicShiftPattern(pattern) && !isRegularEmployee(employee)) {
        return NextResponse.json({ error: '基本勤務は正社員用です。パート/フルタイムパートは時間帯の勤務パターンを選んでください。' }, { status: 400 })
      }

      const { error } = await adminClient
        .from('gw_shift_assignments')
        .upsert(assignmentPayload({
          body: { ...body, shift_label: shiftLabel },
          periodId: period.id,
          workDate,
          pattern,
          employee,
          actorId: auth.user!.id,
          employeeId: employee.id,
        }), { onConflict: 'period_id,user_id,work_date' })
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'generate_draft') {
      const result = await generateDraft(period, auth.user!.id, body.overwrite_ai === true)
      return NextResponse.json({ success: true, ...result })
    }

    return NextResponse.json({ error: '未対応の操作です' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'シフト更新に失敗しました' }, { status: 500 })
  }
}
