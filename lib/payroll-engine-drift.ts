export type PayrollEngineCheck = {
  month: string
  employeeId: string
  inputFingerprint: string
  resultFingerprint: string
  status: string
  reason: string | null
}

export type PayrollEngineDriftIssue = {
  employeeId: string
  component: 'engine'
  kind: 'engine_change' | 'engine_reversal'
  months: string[]
  message: string
}

type EngineSnapshot = { createdAt: string; version: string; engineChecks: PayrollEngineCheck[] }
type Timeline = { employeeId: string; month: string; observations: Map<number, PayrollEngineCheck[]> }
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Compare replays of the same employee/month without fitting their outputs to one another. */
export function detectPayrollEngineDrift(
  current: PayrollEngineCheck[],
  snapshots: EngineSnapshot[],
): PayrollEngineDriftIssue[] {
  const timelines = new Map<string, Timeline>()
  const add = (checks: PayrollEngineCheck[], time: number) => {
    for (const check of checks) {
      if (!hasText(check?.employeeId) || !hasText(check?.month)) continue
      const key = JSON.stringify([check.employeeId, check.month])
      let timeline = timelines.get(key)
      if (!timeline) {
        timeline = { employeeId: check.employeeId, month: check.month, observations: new Map() }
        timelines.set(key, timeline)
      }
      const atTime = timeline.observations.get(time) || []
      atTime.push(check)
      timeline.observations.set(time, atTime)
    }
  }
  for (const snapshot of snapshots) {
    const time = Date.parse(snapshot.createdAt)
    if (Number.isFinite(time)) add(snapshot.engineChecks, time)
  }
  // The caller's replay is always the final observation, regardless of snapshot ordering.
  add(current, Number.POSITIVE_INFINITY)

  const grouped = new Map<string, PayrollEngineDriftIssue>()
  for (const timeline of timelines.values()) {
    let input: string | null = null
    let previous: string | null = null
    let seenResults = new Set<string>()
    let changed = false
    let reversed = false
    for (const [, checks] of [...timeline.observations].sort(([a], [b]) => a - b)) {
      const unique = new Map(checks.map(check => [JSON.stringify([check.inputFingerprint, check.resultFingerprint]), check]))
      const check = unique.values().next().value as PayrollEngineCheck | undefined
      // Conflicting records at one instant have no proven chronology. Missing fingerprints
      // likewise cannot establish unchanged input. Both break the chain conservatively.
      if (unique.size !== 1 || !check || !hasText(check.inputFingerprint) || !hasText(check.resultFingerprint)) {
        input = null
        previous = null
        seenResults = new Set()
        continue
      }
      // Even an amendment later restored to its old value starts a new comparison chain.
      if (input !== check.inputFingerprint) {
        input = check.inputFingerprint
        previous = check.resultFingerprint
        seenResults = new Set([check.resultFingerprint])
        continue
      }
      if (previous !== check.resultFingerprint) {
        changed = true
        if (seenResults.has(check.resultFingerprint)) reversed = true
        seenResults.add(check.resultFingerprint)
        previous = check.resultFingerprint
      }
    }
    if (!changed) continue
    const kind = reversed ? 'engine_reversal' : 'engine_change'
    const key = JSON.stringify([timeline.employeeId, kind])
    const existing = grouped.get(key)
    if (existing) existing.months.push(timeline.month)
    else grouped.set(key, {
      employeeId: timeline.employeeId,
      component: 'engine',
      kind,
      months: [timeline.month],
      message: reversed
        ? '同じ入力のTSG再計算結果が変化した後、過去の結果へ戻る動きを検出しました。計算処理の変更を確認してください。'
        : '同じ入力のTSG再計算結果が保存済みの結果から変化しています。計算処理の変更を確認してください。',
    })
  }
  return [...grouped.values()]
    .map(issue => ({ ...issue, months: [...new Set(issue.months)].sort() }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.kind.localeCompare(b.kind))
}
