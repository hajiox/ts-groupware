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
export const APPRAISAL_TALK_ITEMS = [
  {
    id: 'company_teamwork',
    label: '会社が求めるチームワーク',
    details: [
      'チームワークを大切にし業務に取り組む事',
      '上長をフォローし円滑な運営体制を築く事',
      'ネガティブワードを吐かない事（重要）',
    ],
  },
  {
    id: 'company_skills',
    label: '会社が求めるスキル',
    details: [
      '指示「待ち」はNGです。作業の流れを把握する事',
      'スピードと丁寧さを両立させる事',
      '同じミスを繰り返さない事、作業ミス・労災の撲滅',
    ],
  },
  {
    id: 'company_cost',
    label: '会社が求めるコスト意識',
    details: [
      '電気の節約意識をもつ事',
      '無駄話をしない事、勤務中は作業に集中してください',
    ],
  },
  {
    id: 'requests',
    label: 'その他・要望等',
    details: ['本人からの要望や相談事項を確認する'],
  },
  {
    id: 'harassment',
    label: 'ハラスメントと相談窓口',
    details: [],
  },
] as const

export const APPRAISAL_HARASSMENT_CONTACTS = [
  { name: '佐藤正彦', phone: '090-7521-3061' },
  { name: '藤田香織', phone: '090-2989-1363' },
  { name: '渡部瞳', phone: '090-1374-1949' },
  { name: '佐藤ちさと', phone: '090-5590-4432' },
] as const

export type AppraisalRatings = Record<string, { score: number | null; comment: string }>
export type AppraisalTalkItemId = typeof APPRAISAL_TALK_ITEMS[number]['id']
export type AppraisalTalkChecklist = Record<AppraisalTalkItemId, boolean>
export type AppraisalRecord = {
  id: string; reviewer_id: string; employee_id: string; period_month: string
  assessed_on: string; ratings: AppraisalRatings; talk_checklist: AppraisalTalkChecklist; status: 'draft' | 'completed'
  version: number; updated_at: string; completed_at: string | null
}
export function emptyAppraisalRatings(): AppraisalRatings {
  return Object.fromEntries(APPRAISAL_ITEMS.map(item => [item.id, { score: null, comment: '' }]))
}
export function emptyAppraisalTalkChecklist(): AppraisalTalkChecklist {
  return Object.fromEntries(APPRAISAL_TALK_ITEMS.map(item => [item.id, false])) as AppraisalTalkChecklist
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
  if (!body.talkChecklist || typeof body.talkChecklist !== 'object' || Array.isArray(body.talkChecklist)) throw new Error('面談確認項目が不正です')
  const ratings = body.ratings as Record<string, unknown>
  const talkChecklist = body.talkChecklist as Record<string, unknown>
  if (Object.keys(ratings).length !== APPRAISAL_ITEMS.length) throw new Error('査定項目は10項目です')
  if (Object.keys(talkChecklist).length !== APPRAISAL_TALK_ITEMS.length) throw new Error('面談確認項目は5項目です')
  const result = emptyAppraisalRatings()
  const checked = emptyAppraisalTalkChecklist()
  for (const item of APPRAISAL_ITEMS) {
    const raw = ratings[item.id]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('査定項目が不正です')
    const { score, comment } = raw as Record<string, unknown>
    if (score !== null && (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5)) throw new Error('評価は1〜5で指定してください')
    if (body.status === 'completed' && score === null) throw new Error('全10項目を評価してから完了してください')
    if (typeof comment !== 'string' || comment.length > 2000) throw new Error('備考は各項目2000文字以内です')
    result[item.id] = { score: score as number | null, comment: comment.trim() }
  }
  for (const item of APPRAISAL_TALK_ITEMS) {
    if (typeof talkChecklist[item.id] !== 'boolean') throw new Error('面談確認項目が不正です')
    checked[item.id] = talkChecklist[item.id] as boolean
  }
  return { month: body.month, assessedOn: body.assessedOn, status: body.status, version: body.version as number, ratings: result, talkChecklist: checked }
}
