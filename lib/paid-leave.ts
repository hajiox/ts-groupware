export type ISODate = `${number}-${number}-${number}`

export type PaidLeaveGrantSchedule =
  | { kind: 'standard' }
  | {
      kind: 'proportional'
      weeklyScheduledDays: 1 | 2 | 3 | 4
      annualScheduledDays?: number
    }

export type PaidLeaveGrantScheduleEstimate =
  | PaidLeaveGrantSchedule
  | { kind: 'not_eligible'; annualScheduledDays?: number }
  | { kind: 'unknown' }

export type PaidLeaveGrantSource =
  | 'statutory_standard'
  | 'statutory_proportional'
  | 'initial_company_assumption'
  | 'manual_adjustment'
  | 'carryover_import'

export type PaidLeaveUnit =
  | 'full_day'
  | 'half_day'
  | 'half_day_am'
  | 'half_day_pm'

export type PaidLeaveGrantLot = {
  id: string
  grantDate: ISODate
  expiresOn: ISODate
  grantedDays: number
  adjustedDays?: number
  status?: 'granted' | 'withheld' | 'voided'
}

export type PaidLeaveUsage = {
  id: string
  usedOn: ISODate
  days: number
  status?: 'approved' | 'consumed' | 'cancelled' | 'rejected' | 'voided'
}

export type PaidLeaveAllocation = {
  usageId: string
  grantLotId: string
  days: number
}

export type PaidLeaveShortfall = {
  usageId: string
  usedOn: ISODate
  requestedDays: number
  unallocatedDays: number
}

export type PaidLeaveBalance = {
  asOf: ISODate
  availableDays: number
  expiredUnusedDays: number
  allocatedDays: number
  allocations: PaidLeaveAllocation[]
  shortfalls: PaidLeaveShortfall[]
  lots: Array<{
    id: string
    grantDate: ISODate
    expiresOn: ISODate
    grantedDays: number
    allocatedDays: number
    remainingDays: number
    expired: boolean
  }>
}

export type AttendanceEligibility = {
  rate: number | null
  threshold: number
  thresholdInclusive: boolean
  eligible: boolean | null
  numeratorDays: number
  denominatorDays: number
}

export type PaidLeaveGrantProjection = {
  grantDate: ISODate
  sequenceIndex: number
  serviceMonths: number
  projectedDays: number
  schedule: PaidLeaveGrantScheduleEstimate
  attendance: AttendanceEligibility
  eligibilityBasis: 'attendance' | 'initial_company_assumption' | 'pending'
}

export const STANDARD_GRANT_DAYS = [10, 11, 12, 14, 16, 18, 20] as const

export const PROPORTIONAL_GRANT_DAYS = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
} as const

const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_GRANT_MONTH = 6
const GRANT_INTERVAL_MONTHS = 12
const MAX_GRANT_SEQUENCE_INDEX = STANDARD_GRANT_DAYS.length - 1

function assertFiniteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number`)
  }
}

function parseISODate(value: ISODate | string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError(`Invalid ISO date: ${value}`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`)
  }

  return date
}

function toISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10) as ISODate
}

function compareISODate(left: ISODate | string, right: ISODate | string) {
  return parseISODate(left).getTime() - parseISODate(right).getTime()
}

function daysInUTCMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function addMonthsToISODate(value: ISODate, months: number): ISODate {
  if (!Number.isInteger(months)) {
    throw new RangeError('months must be an integer')
  }

  const source = parseISODate(value)
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + months
  const targetYear = Math.floor(absoluteMonth / 12)
  const targetMonth = ((absoluteMonth % 12) + 12) % 12
  const targetDay = Math.min(
    source.getUTCDate(),
    daysInUTCMonth(targetYear, targetMonth),
  )

  return toISODate(new Date(Date.UTC(targetYear, targetMonth, targetDay)))
}

export function addYearsToISODate(value: ISODate, years: number): ISODate {
  if (!Number.isInteger(years)) {
    throw new RangeError('years must be an integer')
  }
  return addMonthsToISODate(value, years * 12)
}

export function differenceInCalendarDays(
  laterDate: ISODate,
  earlierDate: ISODate,
) {
  return Math.floor(
    (parseISODate(laterDate).getTime() - parseISODate(earlierDate).getTime()) /
      DAY_MS,
  )
}

export function completedServiceMonths(
  hireDate: ISODate,
  asOf: ISODate,
): number {
  if (compareISODate(asOf, hireDate) < 0) return 0

  const hire = parseISODate(hireDate)
  const target = parseISODate(asOf)
  let months =
    (target.getUTCFullYear() - hire.getUTCFullYear()) * 12 +
    target.getUTCMonth() -
    hire.getUTCMonth()

  if (compareISODate(addMonthsToISODate(hireDate, months), asOf) > 0) months -= 1
  return Math.max(0, months)
}

export function completedServiceYears(hireDate: ISODate, asOf: ISODate) {
  return Math.floor(completedServiceMonths(hireDate, asOf) / 12)
}

export function grantDateForSequence(
  hireDate: ISODate,
  sequenceIndex: number,
): ISODate {
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) {
    throw new RangeError('sequenceIndex must be a non-negative integer')
  }

  return addMonthsToISODate(
    hireDate,
    FIRST_GRANT_MONTH + sequenceIndex * GRANT_INTERVAL_MONTHS,
  )
}

export function grantSequenceForServiceMonths(serviceMonths: number) {
  assertFiniteNonNegative(serviceMonths, 'serviceMonths')
  if (serviceMonths < FIRST_GRANT_MONTH) return null

  return Math.min(
    Math.floor((serviceMonths - FIRST_GRANT_MONTH) / GRANT_INTERVAL_MONTHS),
    MAX_GRANT_SEQUENCE_INDEX,
  )
}

export function nextGrantSequence(hireDate: ISODate, asOf: ISODate) {
  if (compareISODate(asOf, hireDate) < 0) {
    return { sequenceIndex: 0, grantDate: grantDateForSequence(hireDate, 0) }
  }

  let sequenceIndex = 0
  while (compareISODate(grantDateForSequence(hireDate, sequenceIndex), asOf) <= 0) {
    sequenceIndex += 1
  }

  return {
    sequenceIndex,
    grantDate: grantDateForSequence(hireDate, sequenceIndex),
  }
}

export function annualDaysToProportionalWeeklyDays(
  annualScheduledDays: number,
): 1 | 2 | 3 | 4 | 5 | null {
  assertFiniteNonNegative(annualScheduledDays, 'annualScheduledDays')
  if (annualScheduledDays >= 217) return 5
  if (annualScheduledDays >= 169) return 4
  if (annualScheduledDays >= 121) return 3
  if (annualScheduledDays >= 73) return 2
  if (annualScheduledDays >= 48) return 1
  return null
}

export function estimateAnnualScheduledDays(input: {
  actualWorkedDays: number
  referenceMonths: number
  firstGrantAssessment?: boolean
}) {
  const { actualWorkedDays, referenceMonths, firstGrantAssessment = false } = input
  assertFiniteNonNegative(actualWorkedDays, 'actualWorkedDays')
  assertFiniteNonNegative(referenceMonths, 'referenceMonths')
  if (referenceMonths === 0) return null

  if (firstGrantAssessment && referenceMonths <= 6) {
    return Math.round(actualWorkedDays * 2)
  }

  return Math.round((actualWorkedDays * 12) / referenceMonths)
}

export function estimatePaidLeaveGrantSchedule(input: {
  weeklyScheduledDays?: number | null
  annualScheduledDays?: number | null
  weeklyScheduledMinutes?: number | null
  actualWorkedDays?: number | null
  referenceMonths?: number | null
  firstGrantAssessment?: boolean
}): PaidLeaveGrantScheduleEstimate {
  const weeklyDays = input.weeklyScheduledDays
  const weeklyMinutes = input.weeklyScheduledMinutes
  let annualDays = input.annualScheduledDays

  if (weeklyMinutes != null) {
    assertFiniteNonNegative(weeklyMinutes, 'weeklyScheduledMinutes')
  }
  if (annualDays != null) {
    assertFiniteNonNegative(annualDays, 'annualScheduledDays')
  }

  if (
    annualDays == null &&
    input.actualWorkedDays != null &&
    input.referenceMonths != null
  ) {
    annualDays = estimateAnnualScheduledDays({
      actualWorkedDays: input.actualWorkedDays,
      referenceMonths: input.referenceMonths,
      firstGrantAssessment: input.firstGrantAssessment,
    })
  }

  if (
    (weeklyMinutes != null && weeklyMinutes >= 30 * 60) ||
    (weeklyDays != null && weeklyDays >= 5) ||
    (annualDays != null && annualDays >= 217)
  ) {
    return { kind: 'standard' }
  }

  if (annualDays != null) {
    const estimatedWeeklyDays = annualDaysToProportionalWeeklyDays(annualDays)
    if (estimatedWeeklyDays === 5) return { kind: 'standard' }
    if (estimatedWeeklyDays == null) {
      return { kind: 'not_eligible', annualScheduledDays: annualDays }
    }
    return {
      kind: 'proportional',
      weeklyScheduledDays: estimatedWeeklyDays,
      annualScheduledDays: annualDays,
    }
  }

  if (weeklyDays != null) {
    if (!Number.isInteger(weeklyDays) || weeklyDays < 0) {
      throw new RangeError('weeklyScheduledDays must be a non-negative integer')
    }
    if (weeklyDays >= 5) return { kind: 'standard' }
    if (weeklyDays >= 1) {
      return {
        kind: 'proportional',
        weeklyScheduledDays: weeklyDays as 1 | 2 | 3 | 4,
      }
    }
    return { kind: 'not_eligible' }
  }

  return { kind: 'unknown' }
}

export function statutoryGrantDays(
  sequenceIndex: number,
  schedule: PaidLeaveGrantScheduleEstimate,
) {
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) {
    throw new RangeError('sequenceIndex must be a non-negative integer')
  }

  const tableIndex = Math.min(sequenceIndex, MAX_GRANT_SEQUENCE_INDEX)
  if (schedule.kind === 'standard') return STANDARD_GRANT_DAYS[tableIndex]
  if (schedule.kind === 'proportional') {
    return PROPORTIONAL_GRANT_DAYS[schedule.weeklyScheduledDays][tableIndex]
  }
  return 0
}

export function calculateAttendanceEligibility(input: {
  numeratorDays: number
  denominatorDays: number
  threshold?: number
  thresholdInclusive?: boolean
}): AttendanceEligibility {
  const {
    numeratorDays,
    denominatorDays,
    threshold = 0.8,
    thresholdInclusive = true,
  } = input
  assertFiniteNonNegative(numeratorDays, 'numeratorDays')
  assertFiniteNonNegative(denominatorDays, 'denominatorDays')

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be between 0 and 1')
  }

  if (denominatorDays === 0) {
    return {
      rate: null,
      threshold,
      thresholdInclusive,
      eligible: null,
      numeratorDays,
      denominatorDays,
    }
  }

  const rate = Math.min(1, numeratorDays / denominatorDays)
  return {
    rate,
    threshold,
    thresholdInclusive,
    eligible: thresholdInclusive ? rate >= threshold : rate > threshold,
    numeratorDays,
    denominatorDays,
  }
}

export function projectNextPaidLeaveGrant(input: {
  hireDate: ISODate
  asOf: ISODate
  schedule: PaidLeaveGrantScheduleEstimate
  attendanceNumeratorDays?: number | null
  attendanceDenominatorDays?: number | null
  attendanceThreshold?: number
  thresholdInclusive?: boolean
  assumeFirstAssessmentEligible?: boolean
}): PaidLeaveGrantProjection {
  const next = nextGrantSequence(input.hireDate, input.asOf)
  const attendance = calculateAttendanceEligibility({
    numeratorDays: input.attendanceNumeratorDays ?? 0,
    denominatorDays: input.attendanceDenominatorDays ?? 0,
    threshold: input.attendanceThreshold,
    thresholdInclusive: input.thresholdInclusive,
  })
  const initialAssumption =
    next.sequenceIndex === 0 &&
    input.assumeFirstAssessmentEligible === true &&
    attendance.eligible == null

  return {
    grantDate: next.grantDate,
    sequenceIndex: next.sequenceIndex,
    serviceMonths:
      FIRST_GRANT_MONTH + next.sequenceIndex * GRANT_INTERVAL_MONTHS,
    projectedDays: statutoryGrantDays(next.sequenceIndex, input.schedule),
    schedule: input.schedule,
    attendance: initialAssumption
      ? { ...attendance, eligible: true }
      : attendance,
    eligibilityBasis: initialAssumption
      ? 'initial_company_assumption'
      : attendance.eligible == null
        ? 'pending'
        : 'attendance',
  }
}

export function isHalfDayIncrement(days: number) {
  return Number.isFinite(days) && days >= 0 && Number.isInteger(days * 2)
}

export function paidLeaveUnitDays(unit: PaidLeaveUnit): 0.5 | 1 {
  return unit === 'full_day' ? 1 : 0.5
}

function toHalfDayUnits(days: number, label: string) {
  if (!isHalfDayIncrement(days)) {
    throw new RangeError(`${label} must be in 0.5-day increments`)
  }
  return Math.round(days * 2)
}

function fromHalfDayUnits(units: number) {
  return units / 2
}

function usageConsumesBalance(usage: PaidLeaveUsage) {
  return usage.status == null || usage.status === 'approved' || usage.status === 'consumed'
}

function lotProvidesBalance(lot: PaidLeaveGrantLot) {
  return lot.status == null || lot.status === 'granted'
}

export function calculatePaidLeaveBalance(input: {
  grants: PaidLeaveGrantLot[]
  usages: PaidLeaveUsage[]
  asOf: ISODate
}): PaidLeaveBalance {
  parseISODate(input.asOf)

  const lots = input.grants
    .filter(lotProvidesBalance)
    .map((lot) => {
      parseISODate(lot.grantDate)
      parseISODate(lot.expiresOn)
      if (compareISODate(lot.expiresOn, lot.grantDate) <= 0) {
        throw new RangeError(`Grant lot ${lot.id} must expire after its grant date`)
      }
      const units =
        toHalfDayUnits(lot.grantedDays, `grant ${lot.id}`) +
        toHalfDayUnits(lot.adjustedDays ?? 0, `grant adjustment ${lot.id}`)
      if (units < 0) {
        throw new RangeError(`Grant lot ${lot.id} cannot have a negative balance`)
      }
      return {
        ...lot,
        totalUnits: units,
        remainingUnits: units,
        allocatedUnits: 0,
      }
    })
    .sort((left, right) => {
      const expiryOrder = compareISODate(left.expiresOn, right.expiresOn)
      return expiryOrder !== 0
        ? expiryOrder
        : compareISODate(left.grantDate, right.grantDate)
    })

  const usages = input.usages
    .filter(usageConsumesBalance)
    .filter((usage) => compareISODate(usage.usedOn, input.asOf) <= 0)
    .map((usage) => ({
      ...usage,
      requestedUnits: toHalfDayUnits(usage.days, `usage ${usage.id}`),
    }))
    .sort((left, right) => compareISODate(left.usedOn, right.usedOn))

  const allocations: PaidLeaveAllocation[] = []
  const shortfalls: PaidLeaveShortfall[] = []

  for (const usage of usages) {
    let unallocatedUnits = usage.requestedUnits

    for (const lot of lots) {
      const usableOnDate =
        compareISODate(lot.grantDate, usage.usedOn) <= 0 &&
        compareISODate(usage.usedOn, lot.expiresOn) < 0
      if (!usableOnDate || lot.remainingUnits === 0) continue

      const allocatedUnits = Math.min(unallocatedUnits, lot.remainingUnits)
      lot.remainingUnits -= allocatedUnits
      lot.allocatedUnits += allocatedUnits
      unallocatedUnits -= allocatedUnits
      allocations.push({
        usageId: usage.id,
        grantLotId: lot.id,
        days: fromHalfDayUnits(allocatedUnits),
      })

      if (unallocatedUnits === 0) break
    }

    if (unallocatedUnits > 0) {
      shortfalls.push({
        usageId: usage.id,
        usedOn: usage.usedOn,
        requestedDays: fromHalfDayUnits(usage.requestedUnits),
        unallocatedDays: fromHalfDayUnits(unallocatedUnits),
      })
    }
  }

  let availableUnits = 0
  let expiredUnusedUnits = 0
  let allocatedUnits = 0
  const lotBalances = lots.map((lot) => {
    const expired = compareISODate(lot.expiresOn, input.asOf) <= 0
    if (expired) expiredUnusedUnits += lot.remainingUnits
    else if (compareISODate(lot.grantDate, input.asOf) <= 0) {
      availableUnits += lot.remainingUnits
    }
    allocatedUnits += lot.allocatedUnits

    return {
      id: lot.id,
      grantDate: lot.grantDate,
      expiresOn: lot.expiresOn,
      grantedDays: fromHalfDayUnits(lot.totalUnits),
      allocatedDays: fromHalfDayUnits(lot.allocatedUnits),
      remainingDays: fromHalfDayUnits(lot.remainingUnits),
      expired,
    }
  })

  return {
    asOf: input.asOf,
    availableDays: fromHalfDayUnits(availableUnits),
    expiredUnusedDays: fromHalfDayUnits(expiredUnusedUnits),
    allocatedDays: fromHalfDayUnits(allocatedUnits),
    allocations,
    shortfalls,
    lots: lotBalances,
  }
}

export function calculateOrdinaryPaidLeaveWage(input: {
  scheduledMinutes: number
  hourlyRate: number
  leaveDays?: 0.5 | 1
}) {
  const { scheduledMinutes, hourlyRate, leaveDays = 1 } = input
  assertFiniteNonNegative(scheduledMinutes, 'scheduledMinutes')
  assertFiniteNonNegative(hourlyRate, 'hourlyRate')
  if (leaveDays !== 0.5 && leaveDays !== 1) {
    throw new RangeError('leaveDays must be 0.5 or 1')
  }

  const payableMinutes = scheduledMinutes * leaveDays
  return {
    payableMinutes,
    amount: Math.round((payableMinutes / 60) * hourlyRate),
  }
}

export function calculateThreeMonthReferenceAverage(input: {
  workedMinutes: number
  workedDays: number
  wageTotal: number
}) {
  const { workedMinutes, workedDays, wageTotal } = input
  assertFiniteNonNegative(workedMinutes, 'workedMinutes')
  assertFiniteNonNegative(workedDays, 'workedDays')
  assertFiniteNonNegative(wageTotal, 'wageTotal')

  return {
    averageMinutesPerWorkedDay:
      workedDays === 0 ? null : Math.round(workedMinutes / workedDays),
    averageWagePerWorkedDay:
      workedDays === 0 ? null : Math.round(wageTotal / workedDays),
  }
}
