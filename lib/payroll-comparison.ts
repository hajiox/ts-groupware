// A missing result cannot be compared. A recorded zero is a valid amount.
export function payrollAmountDelta(calculated: number | null | undefined, labor: number | null | undefined) {
  return calculated == null || labor == null ? null : calculated - labor
}
