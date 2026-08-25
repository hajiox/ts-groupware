import type { AttendanceCalculationPolicy, AttendanceRoundingMethod } from '@/lib/payroll-calculation'

export type AttendanceDeviationKind =
  | 'missing_all'
  | 'missing_clock_in'
  | 'missing_clock_out'
  | 'late'
  | 'early_leave'
  | 'late_and_early'

export type AttendanceDeviationAssignment = {
  id: string
  period_id: string
  work_date: string
  shift_label: string | null
  start_time: string | null
  end_time: string | null
  break_minutes: number | null
  work_minutes: number | null
}

export type AttendanceDeviationPunch = {
  work_date: string
  punched_at: string
  punch_type: 'clock_in' | 'clock_out'
}

export type AttendanceDeviationResolution = {
  work_date: string
  resolution_type: string
  resolution_status: string
}

export type AttendanceDeviation = {
  assignmentId: string
  periodId: string
  workDate: string
  shiftLabel: string | null
  startTime: string | null
  endTime: string | null
  scheduledMinutes: number | null
  actualStartTime: string | null
  actualEndTime: string | null
  lateMinutes: number
  earlyLeaveMinutes: number
  issueKind: AttendanceDeviationKind
  requiresEmployeeAnswer: boolean
  hasActiveResolution: boolean
}

export type AttendanceDeviationTotals = {
  lateCount: number
  earlyLeaveCount: number
  missingPunchCount: number
  lateMinutes: number
  earlyLeaveMinutes: number
}

export type AttendanceDeviationSummary = {
  issues: AttendanceDeviation[]
  actionable: AttendanceDeviation[]
  totals: {
    month: AttendanceDeviationTotals
    year: AttendanceDeviationTotals
    sinceSystemStart: AttendanceDeviationTotals
  }
}

const REGULAR_WORK_STYLES = new Set(['regular_5d_8h', 'regular_6d_6_5h'])
const CLASSIFIED_RESOLUTION_TYPES = new Set([
  'punch_missing',
  'punch_correction',
  'paid_leave_full',
  'paid_leave_half',
  'bereavement_leave',
  'absence',
  'work_schedule_changed',
  'employer_shutdown',
])

function roundValue(value: number, unit: number, method: AttendanceRoundingMethod) {
  if (!Number.isFinite(value) || method === 'none' || unit <= 0) return value
  const scaled = value / unit
  if (method === 'floor') return Math.floor(scaled) * unit
  if (method === 'ceil') return Math.ceil(scaled) * unit
  return Math.round(scaled) * unit
}

function dateSerial(dateText: string) {
  const [year, month, day] = dateText.split('-').map(Number)
  if (![year, month, day].every(Number.isFinite)) return null
  return Date.UTC(year, month - 1, day) / 86400000
}

function timeMinutes(timeText: string | null | undefined) {
  if (!timeText) return null
  const match = /^(\d{1,2}):(\d{2})/.exec(timeText)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return hour * 60 + minute
}

function jstParts(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const dateText = `${values.year}-${values.month}-${values.day}`
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute)
  if (!Number.isFinite(minuteOfDay)) return null
  return {
    dateText,
    minuteOfDay,
    timeText: `${values.hour}:${values.minute}`,
  }
}

function punchMinutePosition(value: string, workDate: string) {
  const parts = jstParts(value)
  const punchDay = parts ? dateSerial(parts.dateText) : null
  const workDay = dateSerial(workDate)
  if (!parts || punchDay === null || workDay === null) return null
  return parts.minuteOfDay + (punchDay - workDay) * 1440
}

function scheduledWindow(assignment: AttendanceDeviationAssignment) {
  const start = timeMinutes(assignment.start_time)
  const rawEnd = timeMinutes(assignment.end_time)
  if (start === null || rawEnd === null) return null
  return {
    start,
    end: rawEnd < start ? rawEnd + 1440 : rawEnd,
  }
}

function scheduledMinutes(assignment: AttendanceDeviationAssignment) {
  if (Number(assignment.work_minutes || 0) > 0) return Number(assignment.work_minutes)
  const window = scheduledWindow(assignment)
  if (!window) return null
  return Math.max(0, window.end - window.start - Number(assignment.break_minutes || 0))
}

function isActiveResolution(resolution: AttendanceDeviationResolution | undefined) {
  return Boolean(resolution && resolution.resolution_status !== 'voided')
}

function isClassifiedResolution(resolution: AttendanceDeviationResolution | undefined) {
  return Boolean(
    resolution
    && resolution.resolution_status === 'admin_confirmed'
    && CLASSIFIED_RESOLUTION_TYPES.has(resolution.resolution_type),
  )
}

function emptyTotals(): AttendanceDeviationTotals {
  return {
    lateCount: 0,
    earlyLeaveCount: 0,
    missingPunchCount: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
  }
}

function addToTotals(target: AttendanceDeviationTotals, issue: AttendanceDeviation) {
  if (issue.lateMinutes > 0) {
    target.lateCount += 1
    target.lateMinutes += issue.lateMinutes
  }
  if (issue.earlyLeaveMinutes > 0) {
    target.earlyLeaveCount += 1
    target.earlyLeaveMinutes += issue.earlyLeaveMinutes
  }
  if (issue.issueKind.startsWith('missing_')) target.missingPunchCount += 1
}

export function analyzeAttendanceDeviations(options: {
  assignments: AttendanceDeviationAssignment[]
  punches: AttendanceDeviationPunch[]
  resolutions: AttendanceDeviationResolution[]
  workStyle: string | null | undefined
  policy: AttendanceCalculationPolicy
  currentDate: string
  deviationStartDate?: string
  skipDates?: ReadonlySet<string>
}) : AttendanceDeviationSummary {
  const punchesByDate = new Map<string, AttendanceDeviationPunch[]>()
  for (const punch of options.punches) {
    const rows = punchesByDate.get(punch.work_date) || []
    rows.push(punch)
    punchesByDate.set(punch.work_date, rows)
  }
  const resolutionByDate = new Map<string, AttendanceDeviationResolution>()
  for (const resolution of options.resolutions) {
    const previous = resolutionByDate.get(resolution.work_date)
    if (!previous || previous.resolution_status === 'voided') {
      resolutionByDate.set(resolution.work_date, resolution)
    }
  }

  const assignmentByDate = new Map<string, AttendanceDeviationAssignment>()
  for (const assignment of options.assignments) {
    if (!assignment.shift_label || assignment.work_date >= options.currentDate) continue
    const existing = assignmentByDate.get(assignment.work_date)
    if (!existing || (!existing.start_time && assignment.start_time)) {
      assignmentByDate.set(assignment.work_date, assignment)
    }
  }

  const regularEmployee = REGULAR_WORK_STYLES.has(options.workStyle || '')
  const issues: AttendanceDeviation[] = []
  for (const assignment of assignmentByDate.values()) {
    if (options.skipDates?.has(assignment.work_date)) continue
    const resolution = resolutionByDate.get(assignment.work_date)
    if (isClassifiedResolution(resolution)) continue

    const dayPunches = (punchesByDate.get(assignment.work_date) || [])
      .sort((left, right) => left.punched_at.localeCompare(right.punched_at))
    const clockIn = dayPunches.find((punch) => punch.punch_type === 'clock_in') || null
    const clockOut = [...dayPunches].reverse().find((punch) => punch.punch_type === 'clock_out') || null
    const window = scheduledWindow(assignment)
    const actualStart = clockIn ? punchMinutePosition(clockIn.punched_at, assignment.work_date) : null
    const actualEnd = clockOut ? punchMinutePosition(clockOut.punched_at, assignment.work_date) : null
    let lateMinutes = 0
    let earlyLeaveMinutes = 0
    let issueKind: AttendanceDeviationKind | null = null

    if (!clockIn && !clockOut) {
      issueKind = 'missing_all'
    } else if (!clockIn) {
      issueKind = 'missing_clock_in'
    } else if (!clockOut) {
      issueKind = 'missing_clock_out'
    } else if (window && actualStart !== null && actualEnd !== null) {
      const roundedStart = roundValue(actualStart, options.policy.roundingUnitMinutes, options.policy.clockInMethod)
      const roundedEnd = roundValue(actualEnd, options.policy.roundingUnitMinutes, options.policy.clockOutMethod)
      lateMinutes = Math.max(0, Math.round(roundedStart - window.start))
      earlyLeaveMinutes = Math.max(0, Math.round(window.end - roundedEnd))
      if (lateMinutes > 0 && earlyLeaveMinutes > 0) issueKind = 'late_and_early'
      else if (lateMinutes > 0) issueKind = 'late'
      else if (earlyLeaveMinutes > 0) issueKind = 'early_leave'
    }

    if (!issueKind) continue
    if (!issueKind.startsWith('missing_') && options.deviationStartDate && assignment.work_date < options.deviationStartDate) {
      continue
    }
    const hasActiveResolution = isActiveResolution(resolution)
    issues.push({
      assignmentId: assignment.id,
      periodId: assignment.period_id,
      workDate: assignment.work_date,
      shiftLabel: assignment.shift_label,
      startTime: assignment.start_time,
      endTime: assignment.end_time,
      scheduledMinutes: scheduledMinutes(assignment),
      actualStartTime: clockIn ? jstParts(clockIn.punched_at)?.timeText || null : null,
      actualEndTime: clockOut ? jstParts(clockOut.punched_at)?.timeText || null : null,
      lateMinutes,
      earlyLeaveMinutes,
      issueKind,
      requiresEmployeeAnswer: issueKind.startsWith('missing_') || regularEmployee,
      hasActiveResolution,
    })
  }

  const totals = {
    month: emptyTotals(),
    year: emptyTotals(),
    sinceSystemStart: emptyTotals(),
  }
  const currentMonth = options.currentDate.slice(0, 7)
  const currentYear = options.currentDate.slice(0, 4)
  for (const issue of issues) {
    addToTotals(totals.sinceSystemStart, issue)
    if (issue.workDate.startsWith(currentYear)) addToTotals(totals.year, issue)
    if (issue.workDate.startsWith(currentMonth)) addToTotals(totals.month, issue)
  }

  return {
    issues: issues.sort((left, right) => right.workDate.localeCompare(left.workDate)),
    actionable: issues
      .filter((issue) => issue.requiresEmployeeAnswer && !issue.hasActiveResolution)
      .sort((left, right) => right.workDate.localeCompare(left.workDate)),
    totals,
  }
}

export function attendanceDeviationLabel(issue: Pick<AttendanceDeviation, 'issueKind' | 'lateMinutes' | 'earlyLeaveMinutes'>) {
  if (issue.issueKind === 'missing_all') return '出勤・退勤の打刻なし'
  if (issue.issueKind === 'missing_clock_in') return '出勤打刻なし'
  if (issue.issueKind === 'missing_clock_out') return '退勤打刻なし'
  if (issue.issueKind === 'late_and_early') return `遅刻${issue.lateMinutes}分・早退${issue.earlyLeaveMinutes}分`
  if (issue.issueKind === 'late') return `遅刻${issue.lateMinutes}分`
  return `早退${issue.earlyLeaveMinutes}分`
}
