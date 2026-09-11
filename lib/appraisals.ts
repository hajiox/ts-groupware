export const APPRAISAL_ITEMS = [
  { id: 'teamwork', label: 'チームワーク及びコミュニケーション', priority: 15 },
  { id: 'instructions', label: '上長指示の徹底', priority: 10 },
  { id: 'concentration', label: '集中力（無駄話など）', priority: 5 },
  { id: 'proficiency', label: '作業の習熟度', priority: 15 },
  { id: 'speed', label: '作業のスピード', priority: 15 },
  { id: 'accuracy', label: '作業ミスの少なさ', priority: 5 },
  { id: 'cost', label: '節電等・コスト意識', priority: 5 },
  { id: 'tidiness', label: '整理整頓', priority: 5 },
  { id: 'safety', label: '安全意識・管理', priority: 5 },
  { id: 'shift', label: 'シフト貢献度', priority: 20 },
] as const

export const APPRAISAL_LABELS = ['未評価', '改善必要', '劣る', '普通', '良い', '非常に良い'] as const
export type AppraisalRatings = Record<string, { score: number | null; comment: string }>
export type AppraisalRecord = {
  id: string; reviewer_id: string; employee_id: string; period_month: string
  assessed_on: string; ratings: AppraisalRatings; status: 'draft' | 'completed'
  version: number; updated_at: string; completed_at: string | null
}
export function emptyAppraisalRatings(): AppraisalRatings {
  return Object.fromEntries(APPRAISAL_ITEMS.map(item => [item.id, { score: null, comment: '' }]))
}
export function validAppraisalMonth(value: unknown): value is string {
  return typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value)
}
export function validAppraisalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function validateAppraisalInput(body: Record<string, unknown>) {
  if (!validAppraisalMonth(body.month)) throw new Error('対象月を正しく指定してください')
  if (!validAppraisalDate(body.assessedOn)) throw new Error('査定日を正しく指定してください')
  if (body.status !== 'draft' && body.status !== 'completed') throw new Error('保存状態が不正です')
  if (!Number.isSafeInteger(body.version) || (body.version as number) < 0) throw new Error('保存バージョンが不正です')
  if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings)) throw new Error('査定項目が不正です')
  const ratings = body.ratings as Record<string, unknown>
  if (Object.keys(ratings).length !== APPRAISAL_ITEMS.length) throw new Error('査定項目は10項目です')
  const result = emptyAppraisalRatings()
  for (const item of APPRAISAL_ITEMS) {
    const raw = ratings[item.id]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('査定項目が不正です')
    const { score, comment } = raw as Record<string, unknown>
    if (score !== null && (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5)) throw new Error('評価は1〜5で指定してください')
    if (body.status === 'completed' && score === null) throw new Error('全10項目を評価してから完了してください')
    if (typeof comment !== 'string' || comment.length > 2000) throw new Error('備考は各項目2000文字以内です')
    result[item.id] = { score: score as number | null, comment: comment.trim() }
  }
  return { month: body.month, assessedOn: body.assessedOn, status: body.status, version: body.version as number, ratings: result }
}
