import type { PaidLeavePaymentSummary } from '@/lib/payroll-calculation'

export function comparisonPaidLeave(
  attendanceSource: 'labor_result' | 'labor_snapshot' | 'punch' | 'none',
  paidLeave: PaidLeavePaymentSummary,
) {
  // Labor-derived hours and rates already reproduce the confirmed base pay.
  // Only a calculation from physical punches needs the separate paid-leave wage.
  return attendanceSource === 'punch' ? paidLeave : undefined
}

// A missing result cannot be compared. A recorded zero is a valid amount.
export function payrollAmountDelta(calculated: number | null | undefined, labor: number | null | undefined) {
  return calculated == null || labor == null ? null : calculated - labor
}
