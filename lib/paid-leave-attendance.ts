export type PaidLeaveUnit = 'full_day' | 'half_day' | 'half_day_am' | 'half_day_pm'

export type PaidLeaveAttendanceProjectionInput = {
  leaveUnit: PaidLeaveUnit
  scheduledMinutes?: number | null
  payableMinutes?: number | null
  assignmentStartTime?: string | null
  assignmentEndTime?: string | null
  assignmentBreakMinutes?: number | null
  profileStartTime?: string | null
  profileEndTime?: string | null
  profileBreakMinutes?: number | null
  physicalClockInTime?: string | null
  physicalClockOutTime?: string | null
  physicalBreakMinutes?: number | null
  breakRules?: Array<{
    minWorkMinutesExclusive: number
    maxWorkMinutesInclusive: number | null
    breakMinutes: number
  }>
}

export type PaidLeaveAttendanceProjection = {
  clockInTime: string
  clockOutTime: string
  breakMinutes: number
  hasPhysicalPunches: boolean
  projectionType: 'paid_leave_full' | 'paid_leave_half_merged' | 'paid_leave_half_only'
  warning: string | null
}

function cleanMinutes(value: number | null | undefined) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

function timeToMinutes(value: string | null | undefined) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return hour * 60 + minute
}

function minutesToTime(value: number) {
  const normalized = ((Math.round(value) % (24 * 60)) + (24 * 60)) % (24 * 60)
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

function elapsedMinutes(start: number, end: number) {
  return end >= start ? end - start : end + 24 * 60 - start
}

export function attendanceBreakMinutes(
  grossMinutes: number,
  breakRules: PaidLeaveAttendanceProjectionInput['breakRules'] = [],
) {
  const configuredRule = [...(breakRules || [])]
    .sort((a, b) => a.minWorkMinutesExclusive - b.minWorkMinutesExclusive)
    .find((rule) => (
      grossMinutes > rule.minWorkMinutesExclusive
      && (rule.maxWorkMinutesInclusive === null || grossMinutes <= rule.maxWorkMinutesInclusive)
    ))
  if (configuredRule) return cleanMinutes(configuredRule.breakMinutes)
  if (grossMinutes > 480) return 60
  if (grossMinutes > 360) return 45
  if (grossMinutes > 300) return 30
  return 0
}

function grossMinutesForNet(
  netMinutes: number,
  breakRules: PaidLeaveAttendanceProjectionInput['breakRules'],
) {
  const target = cleanMinutes(netMinutes)
  for (let gross = target; gross <= target + 120; gross += 1) {
    if (gross - attendanceBreakMinutes(gross, breakRules) >= target) {
      return {
        grossMinutes: gross,
        breakMinutes: attendanceBreakMinutes(gross, breakRules),
      }
    }
  }
  return {
    grossMinutes: target,
    breakMinutes: 0,
  }
}

function plannedStart(input: PaidLeaveAttendanceProjectionInput) {
  return timeToMinutes(input.assignmentStartTime) ?? timeToMinutes(input.profileStartTime)
}

function plannedNetMinutes(input: PaidLeaveAttendanceProjectionInput) {
  const snapshot = cleanMinutes(input.scheduledMinutes)
  if (snapshot > 0) return snapshot

  const start = plannedStart(input)
  const end = timeToMinutes(input.assignmentEndTime) ?? timeToMinutes(input.profileEndTime)
  if (start === null || end === null) return 0
  const breakMinutes = cleanMinutes(
    input.assignmentEndTime ? input.assignmentBreakMinutes : input.profileBreakMinutes,
  )
  return Math.max(0, elapsedMinutes(start, end) - breakMinutes)
}

function physicalNetMinutes(input: PaidLeaveAttendanceProjectionInput) {
  const start = timeToMinutes(input.physicalClockInTime)
  const end = timeToMinutes(input.physicalClockOutTime)
  if (start === null || end === null) return 0
  const grossMinutes = elapsedMinutes(start, end)
  const explicitBreak = input.physicalBreakMinutes
  const breakMinutes = explicitBreak === null || explicitBreak === undefined
    ? attendanceBreakMinutes(grossMinutes, input.breakRules)
    : cleanMinutes(explicitBreak)
  return Math.max(0, grossMinutes - breakMinutes)
}

export function projectPaidLeaveAttendance(
  input: PaidLeaveAttendanceProjectionInput,
): PaidLeaveAttendanceProjection {
  const physicalStart = timeToMinutes(input.physicalClockInTime)
  const physicalEnd = timeToMinutes(input.physicalClockOutTime)
  const hasCompletePhysicalPair = physicalStart !== null && physicalEnd !== null
  const hasAnyPhysicalPunch = physicalStart !== null || physicalEnd !== null
  const scheduleStart = plannedStart(input)
  const fallbackStart = scheduleStart ?? physicalStart ?? 9 * 60
  const scheduledMinutes = plannedNetMinutes(input)
  const payableMinutes = cleanMinutes(input.payableMinutes)
    || Math.round(scheduledMinutes * (input.leaveUnit === 'full_day' ? 1 : 0.5))

  if (input.leaveUnit === 'full_day') {
    const target = grossMinutesForNet(payableMinutes || scheduledMinutes, input.breakRules)
    return {
      clockInTime: minutesToTime(fallbackStart),
      clockOutTime: minutesToTime(fallbackStart + target.grossMinutes),
      breakMinutes: target.breakMinutes,
      hasPhysicalPunches: hasAnyPhysicalPunch,
      projectionType: 'paid_leave_full',
      warning: hasAnyPhysicalPunch ? 'approved_full_day_has_physical_punches' : null,
    }
  }

  if (hasCompletePhysicalPair) {
    const targetNetMinutes = physicalNetMinutes(input) + payableMinutes
    const target = grossMinutesForNet(targetNetMinutes, input.breakRules)
    const start = scheduleStart === null ? physicalStart : Math.min(scheduleStart, physicalStart)
    return {
      clockInTime: minutesToTime(start),
      clockOutTime: minutesToTime(start + target.grossMinutes),
      breakMinutes: target.breakMinutes,
      hasPhysicalPunches: true,
      projectionType: 'paid_leave_half_merged',
      warning: null,
    }
  }

  const target = grossMinutesForNet(payableMinutes, input.breakRules)
  const plannedEnd = timeToMinutes(input.assignmentEndTime) ?? timeToMinutes(input.profileEndTime)
  const startsAtEnd = input.leaveUnit === 'half_day_pm' && plannedEnd !== null
  const start = startsAtEnd ? plannedEnd - target.grossMinutes : fallbackStart
  return {
    clockInTime: minutesToTime(start),
    clockOutTime: minutesToTime(start + target.grossMinutes),
    breakMinutes: target.breakMinutes,
    hasPhysicalPunches: hasAnyPhysicalPunch,
    projectionType: 'paid_leave_half_only',
    warning: hasAnyPhysicalPunch ? 'approved_half_day_has_incomplete_physical_punches' : null,
  }
}
