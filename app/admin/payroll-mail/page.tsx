import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'
import { adminClient } from '@/lib/supabase/admin'
import type { MailComparisonRow } from '@/lib/payroll-mail-comparison'

export const dynamic='force-dynamic'
const REASONS:Record<string,string>={
  calculation_settings_missing:'自社の計算設定がありません',hourly_rate_missing:'時給設定がありません',
  deduction_settings_missing:'控除の自社設定を確認できません',attendance_difference:'社労士の勤務日数・時間と実打刻が異なります',
  monthly_base_missing:'月給設定がありません',attendance_incomplete:'出勤・退勤の組合せが不足しています',
  attendance_missing:'比較に必要な打刻がありません',paid_leave_conflict:'全休有給と打刻が重なっています',
  paid_leave_wage_missing:'有給の支払設定が不足しています',overtime_settings_missing:'残業計算の設定が不足しています',
  invalid_calculation:'計算値を確認できません',unsupported_archive:'ZIP・Excelの内容や対象月を確認できません',
  employee_mapping:'社員の対応を一意に確認できません',period_conflict:'登録済みの勤務月・支給日と一致しません',
  period_locked:'対象月は確定済みです',existing_payroll:'同じ月に別の給与データがあります',
  existing_archive_pending:'同じZIPの既存取込が未完了、または登録内容が一致しません',
  attachment_missing:'ZIPの添付がありません',attachment_ambiguous:'ZIPが複数あり対象を決められません',
  month_unknown:'対象月を確認できません',month_conflict:'対象月の記載が一致しません',archive_too_large:'ZIPがサイズ上限を超えています',
  attachment_unavailable:'添付ファイルを取得できません',mail_auth_failed:'送信元の確認ができません',source_unavailable:'メールを取得できません',
}
function yen(value:number|null) {return value==null?'未確認':`${value>0?'+':''}${value.toLocaleString('ja-JP')}円`}
type JobRow={id:string;payroll_month:string;attendance_month:string;status:string;reason:string|null;created_at:string;report_status:string;
  comparison:{counts?:{employees:number;compared:number;mismatches:number;unverified:number};rows?:MailComparisonRow[]}}
export default async function PayrollMailPage() {
  const user=await getUserSession()
  if(!user) redirect('/login?next=%2Fadmin%2Fpayroll-mail')
  if(!getManagementPermissions(user).canViewPayroll) return <main><h1>給与の閲覧権限が必要です</h1><Link href="/groups">戻る</Link></main>
  const {data,error}=await adminClient.from('gw_payroll_mail_jobs')
    .select('id,payroll_month,attendance_month,status,reason,created_at,report_status,comparison').order('created_at',{ascending:false}).limit(24)
  if(error) return <main><h1>給与メールの取込・検証</h1><p>結果を読み込めませんでした。時間をおいて再度開いてください。</p><Link href="/admin">給与・勤務へ戻る</Link></main>
  const jobs=(data||[]) as JobRow[]
  const ids=[...new Set(jobs.flatMap(job=>(job.comparison?.rows||[]).map(row=>row.employeeId)))]
  const employees=ids.length?await adminClient.from('gw_payroll_employees').select('id,real_name,display_name').in('id',ids):{data:[]}
  const names=new Map((employees.data||[]).map(employee=>[employee.id,employee.real_name||employee.display_name]))
  return <main style={{maxWidth:1100,margin:'24px auto',padding:20}}>
    <Link href="/admin">← 給与・勤務へ戻る</Link>
    <h1>給与メールの取込・検証</h1>
    <p>榎田社労士のZIPと、取込前の自社設定・実打刻・承認済み有給を比較した結果です。自社設定は取込で変更しません。</p>
    <p>金額差は「自社試算 − 社労士」です。税金・保険料等の控除は保存済み設定による試算で、最新の税率から再計算した結果ではありません。設定や打刻が足りない人は「未確認」です。</p>
    {jobs.length===0&&<p>取込の記録はまだありません。</p>}
    {jobs.map(job=>{
      const counts=job.comparison?.counts
      return <section key={job.id} style={{border:'1px solid #cbd5e1',borderRadius:8,padding:16,marginTop:20}}>
        <h2>{job.payroll_month||'対象月未確認'} 給与{job.attendance_month?`（${job.attendance_month}勤務）`:''}</h2>
        <p>{job.status==='imported'?'取込済み':'要確認・取込未完了'} / DM {job.report_status==='sent'?'送信済み':'送信待ち'}</p>
        <p>{new Date(job.created_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>
        {job.reason&&<p>{REASONS[job.reason]||'内容の確認が必要です'}。既存の給与データは変更していません。</p>}
        {counts&&<p>対象 {counts.employees}人 / 比較 {counts.compared}人 / 差異 {counts.mismatches}人 / 未確認 {counts.unverified}人</p>}
        {!!job.comparison?.rows?.length&&<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>{['社員','結果','支給差','控除差','手取差','確認内容'].map(label=><th key={label} style={{textAlign:'left',padding:8,borderBottom:'1px solid #cbd5e1'}}>{label}</th>)}</tr></thead>
          <tbody>{job.comparison.rows.map(row=><tr key={row.employeeId}>
            <td style={{padding:8}}>{names.get(row.employeeId)||'社員情報を確認できません'}</td>
            <td>{row.status==='matched'?'試算一致':row.status==='mismatch'?'差異あり':'未確認'}</td>
            <td>{yen(row.paymentDelta)}</td><td>{yen(row.deductionDelta)}</td><td>{yen(row.netDelta)}</td>
            <td>{row.reason?REASONS[row.reason]||'確認が必要です':'保存済み自社設定による試算'}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    })}
  </main>
}
