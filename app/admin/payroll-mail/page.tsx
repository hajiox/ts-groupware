import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'
import { adminClient } from '@/lib/supabase/admin'
import type { MailComparisonRow } from '@/lib/payroll-mail-comparison'

export const dynamic='force-dynamic'
const REASONS:Record<string,string>={
  earning_items_difference:'基本給・残業の計算と支給明細に差があります',
  calculation_settings_missing:'自社の計算設定がありません',hourly_rate_missing:'時給設定がありません',
  deduction_settings_missing:'控除の自社設定を確認できません',attendance_difference:'社労士の勤務日数・時間と実打刻が異なります',
  monthly_base_missing:'月給設定がありません',attendance_incomplete:'出勤・退勤の組合せが不足しています',
  attendance_missing:'比較に必要な打刻がありません',paid_leave_conflict:'全休有給と打刻が重なっています',
  paid_leave_wage_missing:'有給の支払設定が不足しています',overtime_settings_missing:'残業計算の設定が不足しています',
  labor_attendance_missing:'労務士資料の就労時間・残業時間が不足しています',labor_rate_missing:'労務士資料の単価を確認できません',
  declared_rate_missing:'計算に必要な時給を確認できません',deduction_items_missing:'当月の控除内訳を確認できません',
  deduction_items_mismatch:'当月の控除内訳合計と控除総額が異なります',
  invalid_calculation:'計算値を確認できません',unsupported_archive:'ZIP・Excelの内容や対象月を確認できません',
  employee_mapping:'社員の対応を一意に確認できません',period_conflict:'登録済みの勤務月・支給日と一致しません',
  period_locked:'対象月は確定済みです',existing_payroll:'同じ月に別の給与データがあります',
  existing_archive_pending:'同じZIPの既存取込が未完了、または登録内容が一致しません',
  attachment_missing:'ZIPの添付がありません',attachment_ambiguous:'ZIPが複数あり対象を決められません',
  month_unknown:'対象月を確認できません',month_conflict:'対象月の記載が一致しません',archive_too_large:'ZIPがサイズ上限を超えています',
  attachment_unavailable:'添付ファイルを取得できません',mail_auth_failed:'送信元の確認ができません',source_unavailable:'メールを取得できません',
}
function yen(value:number|null) {return value==null?'未確認':`${value>0?'+':''}${value.toLocaleString('ja-JP')}円`}
type DisplayComparisonRow=MailComparisonRow & {
  profileSource?:'stored'|'labor_declared';
  deductionBasis?:'labor_item_sum'|'unverified';
  operational?:{status:'matched'|'mismatch'|'unverified';reason:string|null;paymentDelta:number|null;netDelta:number|null;deductionDelta:number|null};
}
type JobRow={id:string;payroll_month:string;attendance_month:string;status:string;reason:string|null;created_at:string;report_status:string;
  comparison:{basis?:string;version?:number;calculatedAt?:string;counts?:{employees:number;compared:number;mismatches:number;unverified:number};rows?:DisplayComparisonRow[]}}
export default async function PayrollMailPage() {
  const user=await getUserSession()
  if(!user) redirect('/login?next=%2Fadmin%2Fpayroll-mail')
  if(!getManagementPermissions(user).canViewPayroll) return <main className="safe-area-page"><h1>給与の閲覧権限が必要です</h1><Link href="/groups">戻る</Link></main>
  const {data,error}=await adminClient.from('gw_payroll_mail_jobs')
    .select('id,payroll_month,attendance_month,status,reason,created_at,report_status,comparison').order('created_at',{ascending:false}).limit(24)
  if(error) return <main className="safe-area-page"><h1>給与メールの取込・検証</h1><p>結果を読み込めませんでした。時間をおいて再度開いてください。</p><Link href="/admin">給与・勤務へ戻る</Link></main>
  const jobs=(data||[]) as JobRow[]
  const ids=[...new Set(jobs.flatMap(job=>(job.comparison?.rows||[]).map(row=>row.employeeId)))]
  const employees=ids.length?await adminClient.from('gw_payroll_employees').select('id,real_name,display_name').in('id',ids):{data:[]}
  const names=new Map((employees.data||[]).map(employee=>[employee.id,employee.real_name||employee.display_name]))
  return <main className="safe-area-page" style={{maxWidth:1100,margin:'24px auto'}}>
    <Link href="/admin">← 給与・勤務へ戻る</Link>
    <h1>給与メールの取込・検証</h1>
    <p><Link href="/admin/payroll-stability">給与計算ルールの月次検証を見る</Link></p>
    <p>労務士資料の勤怠・記載単価を使い、TSGの給与式による金額と照合します。実打刻からの試算は別に表示します。</p>
    <p>固定給は保存済みの適用設定と照合し、設定がない場合は資料から補完します。手当は当月資料の内訳を使います。</p>
    <p>金額差は「TSGの計算 − 労務士」です。控除差は当月資料の控除内訳合計と控除総額の照合で、税金・保険料の法定額を再計算した結果ではありません。必要な入力を確認できない項目は「未確認」です。</p>
    {jobs.length===0&&<p>取込の記録はまだありません。</p>}
    {jobs.map(job=>{
      const counts=job.comparison?.counts
      const aligned=job.comparison?.basis==='labor_attendance_and_declared_rates'
      const operationalRows=aligned?(job.comparison?.rows||[]).filter(row=>row.operational):[]
      return <section key={job.id} style={{border:'1px solid #cbd5e1',borderRadius:8,padding:16,marginTop:20}}>
        <h2>{job.payroll_month||'対象月未確認'} 給与{job.attendance_month?`（${job.attendance_month}勤務）`:''}</h2>
        <p>{job.status==='imported'?'取込済み':'要確認・取込未完了'} / DM {job.report_status==='sent'?'送信済み':'送信待ち'}</p>
        <p>{new Date(job.created_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>
        {aligned?<p>労務士入力による給与式比較{job.comparison.calculatedAt?` / 再計算 ${new Date(job.comparison.calculatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`:''}</p>
          :!!job.comparison?.rows?.length&&<p>旧方式の実打刻試算です。この記録の差異には、労務士と実打刻の勤怠差や前月設定との差が含まれます。</p>}
        {job.reason&&<p>{REASONS[job.reason]||'内容の確認が必要です'}。既存の給与データは変更していません。</p>}
        {counts&&<p>対象 {counts.employees}人 / 比較 {counts.compared}人 / {aligned?'給与式・控除内訳の差異':'旧方式の試算差異'} {counts.mismatches}人 / 未確認 {counts.unverified}人</p>}
        {!!job.comparison?.rows?.length&&<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
          <caption style={{textAlign:'left',marginBottom:8}}>{aligned?'労務士入力による給与式比較':'旧方式の実打刻試算'}</caption>
          <thead><tr>{['社員','結果','支給差',aligned?'控除内訳差':'控除差','手取差','確認内容'].map(label=><th key={label} style={{textAlign:'left',padding:8,borderBottom:'1px solid #cbd5e1'}}>{label}</th>)}</tr></thead>
          <tbody>{job.comparison.rows.map(row=><tr key={row.employeeId}>
            <td style={{padding:8}}>{names.get(row.employeeId)||'社員情報を確認できません'}</td>
            <td>{row.status==='matched'?(aligned?'比較範囲一致':'試算一致'):row.status==='mismatch'?'差異あり':'未確認'}</td>
            <td>{yen(row.paymentDelta)}</td><td>{yen(row.deductionDelta)}</td><td>{yen(row.netDelta)}</td>
            <td>{row.reason?REASONS[row.reason]||'確認が必要です':aligned?'労務士の勤怠・記載単価による計算':'保存済み自社設定による試算'}
              {aligned&&row.profileSource==='labor_declared'&&<small style={{display:'block'}}>当月資料の記載金額・単価で計算設定を補完</small>}
              {aligned&&<small style={{display:'block'}}>{row.deductionBasis==='labor_item_sum'?'控除は当月資料の内訳合計を照合':'控除内訳は未確認'}</small>}
            </td>
          </tr>)}</tbody>
        </table></div>}
        {!!operationalRows.length&&<div style={{overflowX:'auto',marginTop:20}}><table style={{width:'100%',borderCollapse:'collapse'}}>
          <caption style={{textAlign:'left',marginBottom:8}}>実打刻による参考試算（上の給与式比較の差異人数には含めません）</caption>
          <thead><tr>{['社員','実打刻試算','参考支給差','参考手取差','確認内容'].map(label=><th key={label} style={{textAlign:'left',padding:8,borderBottom:'1px solid #cbd5e1'}}>{label}</th>)}</tr></thead>
          <tbody>{operationalRows.map(row=><tr key={row.employeeId}>
            <td style={{padding:8}}>{names.get(row.employeeId)||'社員情報を確認できません'}</td>
            <td>{row.operational!.status==='matched'?'試算一致':row.operational!.status==='mismatch'?'参考差異あり':'未確認'}</td>
            <td>{yen(row.operational!.paymentDelta)}</td><td>{yen(row.operational!.netDelta)}</td>
            <td>{row.operational!.reason?REASONS[row.operational!.reason]||'確認が必要です':row.attendanceDifference?'労務士資料と実打刻の勤怠が異なります':'実打刻と承認済み有給による参考試算'}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    })}
  </main>
}
