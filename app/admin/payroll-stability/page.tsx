import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'
import { adminClient } from '@/lib/supabase/admin'
import { loadPayrollRuleStability } from '@/lib/payroll-rule-stability-data'

export const dynamic = 'force-dynamic'

type StabilityReport = Awaited<ReturnType<typeof loadPayrollRuleStability>>
type StabilityIssue = StabilityReport['issues'][number]

const COMPONENT_LABELS: Record<string, string> = {
  base: '基本給',
  base_pay: '基本給',
  regular_salary: '基本給',
  hourly_base: '時給の基本給',
  monthly_base: '月給の基本給',
  base_salary: '基本給',
  weekday_overtime: '平日残業',
  ordinary_overtime: '平日残業',
  sunday_overtime: '休日残業',
  engine: 'TSG計算結果',
  input: '計算入力',
}

const RULE_LABELS: Record<string, string> = {
  amount_nearest: '計算額を四捨五入',
  amount_floor: '計算額を切り捨て',
  amount_ceil: '計算額を切り上げ',
  unit_nearest_amount_nearest: '単価を四捨五入 → 計算額を四捨五入',
  unit_nearest_amount_floor: '単価を四捨五入 → 計算額を切り捨て',
  unit_nearest_amount_ceil: '単価を四捨五入 → 計算額を切り上げ',
  fixed_monthly: '固定月給',
}

function formatMonth(value: string | null) {
  if (!value) return '未確認'
  const match = /^(\d{4})-(\d{2})/.exec(value)
  return match ? `${match[1]}年${Number(match[2])}月` : value
}

function IssueList({ issues, names }: { issues: StabilityIssue[]; names: Map<string, string> }) {
  return <ul className="space-y-3">
    {issues.map((issue, index) => {
      const fromRules = 'fromRules' in issue ? issue.fromRules : []
      const toRules = 'toRules' in issue ? issue.toRules : []
      return <li key={`${issue.employeeId}:${issue.component}:${issue.kind}:${index}`} className="rounded-md border border-border p-3">
      <p className="font-medium">{names.get(issue.employeeId) || '社員情報を確認できません'} / {COMPONENT_LABELS[issue.component] || issue.component}</p>
      <p className="mt-1 text-sm">{issue.message}</p>
      <p className="mt-1 text-sm text-muted-foreground">対象月: {issue.months.map(formatMonth).join('、') || '未確認'}</p>
      {!!fromRules?.length && <p className="mt-1 text-sm text-muted-foreground">変更前の候補: {fromRules.map(rule => RULE_LABELS[rule] || rule).join('、')}</p>}
      {!!toRules?.length && <p className="mt-1 text-sm text-muted-foreground">変更後の候補: {toRules.map(rule => RULE_LABELS[rule] || rule).join('、')}</p>}
    </li>})}
  </ul>
}

function IssueSection({ title, description, issues, names, open = false }: {
  title: string
  description: string
  issues: StabilityIssue[]
  names: Map<string, string>
  open?: boolean
}) {
  return <details className="rounded-lg border border-border p-4" open={open}>
    <summary className="cursor-pointer font-semibold">{title}（{issues.length}件）</summary>
    <p className="my-3 text-sm text-muted-foreground">{description}</p>
    {issues.length ? <IssueList issues={issues} names={names} /> : <p className="text-sm">該当する検出はありません。</p>}
  </details>
}

export default async function PayrollStabilityPage() {
  const user = await getUserSession()
  if (!user) redirect('/login?next=%2Fadmin%2Fpayroll-stability')
  if (!getManagementPermissions(user).canViewPayroll) {
    return <main className="safe-area-page mx-auto max-w-5xl space-y-4 p-5">
      <h1 className="text-xl font-semibold">給与の閲覧権限が必要です</h1>
      <Link className="underline" href="/groups">戻る</Link>
    </main>
  }

  let report: StabilityReport
  let names: Map<string, string>
  try {
    report = await loadPayrollRuleStability()
    const employeeIds = [...new Set(report.issues.map(issue => issue.employeeId))]
    const employees = employeeIds.length
      ? await adminClient.from('gw_payroll_employees').select('id,real_name,display_name').in('id', employeeIds)
      : { data: [], error: null }
    if (employees.error) throw new Error('employee_names_unavailable')
    names = new Map((employees.data || []).map(employee => [employee.id, employee.real_name || employee.display_name || '氏名未登録']))
  } catch {
    return <main className="safe-area-page mx-auto max-w-5xl space-y-4 p-5">
      <Link className="underline" href="/admin/payroll-mail">← 給与メールの取込・検証へ戻る</Link>
      <h1 className="text-2xl font-semibold">給与計算ルールの月次検証</h1>
      <p role="alert" className="rounded-lg border border-destructive p-4">検証結果を読み込めませんでした。異常の有無は未確認です。時間をおいて再度開いてください。</p>
    </main>
  }

  const ruleReversals = report.issues.filter(issue => issue.kind === 'rule_reversal')
  const ruleChanges = report.issues.filter(issue => issue.kind === 'rule_change')
  const settingsChanges = report.issues.filter(issue => issue.kind === 'settings_change')
  const formulaMismatches = report.issues.filter(issue => issue.kind === 'formula_mismatch')
  const missingInputs = report.issues.filter(issue => issue.kind === 'missing_input')
  const engineChanges = report.issues.filter(issue => issue.kind === 'engine_change' || issue.kind === 'engine_reversal')
  const classifiedKinds = new Set(['rule_reversal', 'rule_change', 'settings_change', 'formula_mismatch', 'missing_input', 'engine_change', 'engine_reversal'])
  const otherIssues = report.issues.filter(issue => !classifiedKinds.has(issue.kind))

  return <main className="safe-area-page mx-auto max-w-6xl space-y-5 p-5">
    <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <Link className="underline" href="/admin/payroll-mail">← 給与メールの取込・検証</Link>
      <Link className="underline" href="/admin">給与・勤務</Link>
    </nav>
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">給与計算ルールの月次検証</h1>
      <p>保存済みの直近24給与月を同じ候補式で照合し、月ごとの計算方法の変更や「A → B → A」の往復を検出します。給与額や計算設定は変更しません。</p>
      <p className="text-sm text-muted-foreground">時給・残業などの記載単価、勤怠、保存済み設定を使います。合う金額から単価や式を逆算して合わせる処理は行いません。税金・保険料の法定額は独立した再計算の対象外です。</p>
      <p className="text-sm text-muted-foreground">複数の式で同額になる項目は「判別不能」です。同じ計算方法が続いていると確定した件数には含めません。必要な入力がない項目は「未確認」として分けます。</p>
      <p className="text-sm text-muted-foreground">TSG側の計算結果も、保存した検証記録と同じ入力で比較します。保存済み記録と同じ入力を確認できた給与結果は {report.baselineComparedChecks}件です。最初の記録を保存する前のソフトウェア変更は、この比較だけでは確認できません。</p>
      {report.snapshotCount != null && <p className="text-sm text-muted-foreground">TSG計算結果の保存済み検証記録: {report.snapshotCount}件</p>}
      <p className="text-xs text-muted-foreground">検証版 {report.version} / 生成 {new Date(report.calculatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
        {report.periodCount > 0 && ` / ${formatMonth(report.historyFrom)}〜${formatMonth(report.historyTo)}（${report.periodCount}給与月）`}
      </p>
    </header>

    {report.periodCount === 0 ? <p className="rounded-lg border border-border p-4">検証対象の保存済み給与データがありません。</p> : <>
      <section aria-label="検出件数" className="rounded-lg border border-border p-4">
        <p className="font-semibold">ロジック往復候補 {report.totals.ruleReversals}件 / ルール変更候補 {report.totals.ruleChanges}件 / 設定変更 {report.totals.settingsChanges}件</p>
        <p className="mt-2 text-sm font-medium">同じ入力でTSGの計算結果が変わった記録 {engineChanges.length}件</p>
        <p className="mt-2 text-sm">検証 {report.totals.checkedComponents}項目 / 一致 {report.totals.matchedComponents}項目 / 式の不一致 {report.totals.mismatchedComponents}項目 / 判別不能 {report.totals.ambiguousComponents}項目 / 未確認 {report.totals.unverifiedComponents}項目</p>
        <p className="mt-2 text-sm text-muted-foreground">候補の変化は確認が必要な兆候です。昇給などの設定変更と計算方法の変化は分けて表示します。</p>
      </section>

      <section className="overflow-x-auto rounded-lg border border-border p-4" aria-labelledby="monthly-results">
        <h2 id="monthly-results" className="mb-3 text-lg font-semibold">月別の照合結果</h2>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">給与月ごとの給与項目照合件数</caption>
          <thead><tr>{['給与月', '検証項目', '一致', '式の不一致', '判別不能', '未確認'].map(label => <th key={label} scope="col" className="whitespace-nowrap border-b border-border px-3 py-2 text-right first:text-left">{label}</th>)}</tr></thead>
          <tbody>{report.months.map(month => <tr key={month.month} className="border-b border-border last:border-0">
            <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{formatMonth(month.month)}</th>
            <td className="px-3 py-2 text-right">{month.checkedComponents}</td>
            <td className="px-3 py-2 text-right">{month.matchedComponents}</td>
            <td className="px-3 py-2 text-right">{month.mismatchedComponents}</td>
            <td className="px-3 py-2 text-right">{month.ambiguousComponents}</td>
            <td className="px-3 py-2 text-right">{month.unverifiedComponents}</td>
          </tr>)}</tbody>
        </table>
      </section>

      <IssueSection title="同じ入力でTSGの計算結果が変わった記録" description="入力の一致を確認したうえで、TSGの再計算結果が保存済みの結果から変わっています。計算処理の変更や、以前の結果への往復を確認してください。給与データや設定は自動修正しません。" issues={engineChanges} names={names} open={engineChanges.length > 0} />
      <IssueSection title="ロジック往復候補" description="一致する候補式が変わり、その後以前の候補へ戻った項目です。毎月の差額だけで式を変更していないか確認してください。" issues={ruleReversals} names={names} open={ruleReversals.length > 0} />
      <IssueSection title="ルール変更候補" description="前後の月で一致する候補式が変わった項目です。判別不能の月から計算方法の継続を断定しません。" issues={ruleChanges} names={names} open={ruleChanges.length > 0} />
      <IssueSection title="設定変更" description="記載単価や保存済みの計算設定の変更です。昇給などによる変更と、計算方法の変更を区別して確認できます。" issues={settingsChanges} names={names} />
      <IssueSection title="候補式に一致しない項目" description="必要な入力はありますが、固定した候補式のいずれでも明細額を再現できません。単価を逆算して一致扱いにはしていません。" issues={formulaMismatches} names={names} />
      <IssueSection title="入力不足で未確認の項目" description="勤務時間・記載単価・設定などが不足し、式を照合できない項目です。差異なしとは扱いません。" issues={missingInputs} names={names} />
      {otherIssues.length > 0 && <IssueSection title="その他の確認事項" description="上記以外の検証結果です。" issues={otherIssues} names={names} />}
    </>}
  </main>
}
