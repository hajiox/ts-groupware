export type ShiftConstraintInput = {
  maxWorkDays?: number | null
  targetWorkDays?: number | null
  minDaysOff?: number | null
  maxConsecutiveDays?: number | null
}

export type ShiftConstraints = {
  maxWorkDays: number
  targetWorkDays: number
  minDaysOff: number
  maxConsecutiveDays: number
  effectiveMaxWorkDays: number
}

function integerOrNull(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.trunc(Number(value)) : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function defaultTargetWorkDays(workStyle: string | null | undefined, periodDays: number) {
  if (workStyle === 'regular_6d_6_5h') return Math.round(periodDays * 6 / 7)
  if (workStyle === 'regular_5d_8h' || workStyle === 'full_time_part') return Math.round(periodDays * 5 / 7)
  if (workStyle === 'part_time_under_29_5h') return Math.round(periodDays * 4 / 7)
  if (workStyle === 'officer') return Math.round(periodDays * 5 / 7)
  return Math.round(periodDays * 5 / 7)
}

export function defaultMaxConsecutiveDays(workStyle: string | null | undefined) {
  return workStyle === 'regular_5d_8h' ? 5 : 6
}

export function resolveShiftConstraints(
  workStyle: string | null | undefined,
  periodDays: number,
  input: ShiftConstraintInput = {},
): ShiftConstraints {
  const days = Math.max(1, Math.trunc(periodDays))
  const defaultTarget = clamp(defaultTargetWorkDays(workStyle, days), 0, days)
  const maxWorkDays = clamp(integerOrNull(input.maxWorkDays) ?? days, 0, days)
  const minDaysOff = clamp(integerOrNull(input.minDaysOff) ?? Math.max(0, days - defaultTarget), 0, days)
  const effectiveMaxWorkDays = Math.min(maxWorkDays, Math.max(0, days - minDaysOff))
  const targetWorkDays = clamp(integerOrNull(input.targetWorkDays) ?? defaultTarget, 0, effectiveMaxWorkDays)
  const maxConsecutiveDays = clamp(integerOrNull(input.maxConsecutiveDays) ?? defaultMaxConsecutiveDays(workStyle), 1, days)

  return {
    maxWorkDays,
    targetWorkDays,
    minDaysOff,
    maxConsecutiveDays,
    effectiveMaxWorkDays,
  }
}

export function shiftWorkStyleLabel(value: string | null | undefined) {
  if (value === 'regular_5d_8h') return '5日正社員'
  if (value === 'regular_6d_6_5h') return '6日正社員'
  if (value === 'part_time_under_29_5h') return 'パート'
  if (value === 'full_time_part') return '準社員（フルタイムパート）'
  if (value === 'officer') return '役員'
  return '勤務形態未設定'
}
