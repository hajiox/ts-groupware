import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { POST as sendDirectMessage } from '@/app/api/integrations/tsa/direct-message/route'
import { adminClient } from '@/lib/supabase/admin'
import { checkPayrollArchiveStorage, initializePayrollArchiveStorage, PayrollArchiveStorageError, uploadPayrollArchiveToDrive } from '@/lib/drive'
import { parsePayrollMailArchive } from '@/lib/payroll-mail-archive'
import { parseLaborPayrollZip, matchLaborPayrollEmployees, type EmployeeRow } from '@/lib/labor-payroll-zip'
import { loadAllRows } from '@/lib/supabase-pagination'
import { loadAttendanceCalculationPolicy } from '@/lib/payroll-attendance-policy-data'
import type { PunchLike, PaidLeavePaymentLike } from '@/lib/payroll-calculation'
import {
  comparePayrollMailEmployee, payrollMailComparisonCounts, selectIndependentProfile,
  type MailComparisonProfile,
} from '@/lib/payroll-mail-comparison'
import { getEffectiveUserRole, normalizeUserName } from '@/lib/user-roles'
import { loadPayrollRuleStability } from '@/lib/payroll-rule-stability-data'

export const PAYROLL_MAIL_MAX_ZIP_BYTES = 3 * 1024 * 1024
export const PAYROLL_MAIL_MAX_JSON_BYTES = 4_300_000
export const PAYROLL_MAIL_SENDER = 'tatuya.enokida@gmail.com'
export const PAYROLL_MAIL_REVIEW_CODES = [
  'attachment_missing','attachment_ambiguous','month_unknown','month_conflict','archive_too_large',
  'attachment_unavailable','mail_auth_failed','unsupported_archive','source_unavailable',
] as const
const SITE = 'https://v0-line-blush.vercel.app'
const EMPTY_COUNTS = { employees: 0, compared: 0, mismatches: 0, unverified: 0 }

export class PayrollMailError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
type Metadata = {
  sourceKey: string; messageId: string; attachmentId: string; fileName: string;
  sha256: string; payrollMonth: string; attendanceMonth: string; receivedAt: string; sender: string;
}
export type PayrollMailInput =
  | (Metadata & { mode: 'import'; buffer: Buffer })
  | (Metadata & { mode: 'review'; errorCode: string })
  | { mode: 'retry_report'; sourceKey: string }
  | { mode: 'initialize_storage' }
type Counts = typeof EMPTY_COUNTS
type Job = {
  id: string; original_source_key: string; message_id: string; zip_sha256: string;
  payroll_month: string; attendance_month: string; status: 'imported'|'needs_review';
  reason: string | null; batch_id: string | null; comparison: { counts?: Counts };
  report_content: string; report_status: 'pending'|'sent'; duplicate?: boolean;
}
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex') }
function text(value: unknown, maximum: number, optional = false) {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || (!optional && !value)) {
    throw new PayrollMailError('invalid_request',400)
  }
  return value
}
function month(value: unknown, optional: boolean) {
  const result = text(value,7,optional)
  if (result && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(result)) throw new PayrollMailError('invalid_month',400)
  return result
}
export function parsePayrollMailInput(raw: unknown): PayrollMailInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PayrollMailError('invalid_request',400)
  const body = raw as Record<string,unknown>
  if(body.action==='initialize_storage') {
    if(Object.keys(body).length!==1) throw new PayrollMailError('unknown_field',400)
    return {mode:'initialize_storage'}
  }
  const retry = body.action === 'retry_report'
  const review = body.status === 'needs_review'
  const keys = retry ? ['action','sourceKey'] : [
    'sourceKey','messageId','attachmentId','fileName','sha256','payrollMonth','attendanceMonth','receivedAt','sender',
    ...(review ? ['status','errorCode'] : ['zipBase64']),
  ]
  if (Object.keys(body).some(key => !keys.includes(key))) throw new PayrollMailError('unknown_field',400)
  const sourceKey = text(body.sourceKey,200)
  if (!/^[A-Za-z0-9:_-]+$/.test(sourceKey)) throw new PayrollMailError('invalid_source_key',400)
  if (retry) return { mode:'retry_report',sourceKey }
  const errorCode = review ? text(body.errorCode,80) : ''
  if (review && !(PAYROLL_MAIL_REVIEW_CODES as readonly string[]).includes(errorCode)) throw new PayrollMailError('invalid_review_code',400)
  const sender = text(body.sender,254)
  if (sender !== PAYROLL_MAIL_SENDER) throw new PayrollMailError('sender_not_allowed',400)
  const metadata: Metadata = {
    sourceKey, sender, messageId:text(body.messageId,200),attachmentId:text(body.attachmentId,500,review),
    fileName:text(body.fileName,240,review),sha256:text(body.sha256,64,review),
    payrollMonth:month(body.payrollMonth,review),attendanceMonth:month(body.attendanceMonth,review),
    receivedAt:text(body.receivedAt,40,review && errorCode==='source_unavailable'),
  }
  if (metadata.receivedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.receivedAt)
    || !Number.isFinite(Date.parse(metadata.receivedAt)))) throw new PayrollMailError('invalid_received_at',400)
  if (metadata.sha256 && !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new PayrollMailError('invalid_sha256',400)
  if (review) return { ...metadata,mode:'review',errorCode }
  if (!metadata.fileName.toLowerCase().endsWith('.zip') || /[\\/]/.test(metadata.fileName)) throw new PayrollMailError('invalid_file_name',400)
  const encoded = text(body.zipBase64,4*1024*1024)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new PayrollMailError('invalid_base64',400)
  const buffer = Buffer.from(encoded,'base64')
  if (!buffer.length || buffer.length > PAYROLL_MAIL_MAX_ZIP_BYTES) throw new PayrollMailError('archive_too_large',413)
  if (buffer.toString('base64') !== encoded || sha256(buffer)!==metadata.sha256) throw new PayrollMailError('archive_hash_mismatch',400)
  const previous = new Date(`${metadata.payrollMonth}-01T00:00:00Z`)
  previous.setUTCMonth(previous.getUTCMonth()-1)
  if (previous.toISOString().slice(0,7)!==metadata.attendanceMonth) throw new PayrollMailError('month_conflict',400)
  return { ...metadata,mode:'import',buffer }
}

function fingerprint(input: Exclude<PayrollMailInput,{mode:'retry_report'}|{mode:'initialize_storage'}>) {
  return sha256(JSON.stringify({mode:input.mode,sourceKey:input.sourceKey,messageId:input.messageId,
    attachmentId:input.attachmentId,fileName:input.fileName,sha256:input.sha256,payrollMonth:input.payrollMonth,
    attendanceMonth:input.attendanceMonth,receivedAt:input.receivedAt,sender:input.sender,
    errorCode:input.mode==='review'?input.errorCode:undefined}))
}
export function buildPayrollMailReport(monthValue: string, attendanceValue: string, counts: Counts, review = false, reasons:Record<string,number> = {}) {
  const period = monthValue ? `${monthValue.replace('-','年')}月給与${attendanceValue ? `（${Number(attendanceValue.slice(5))}月勤務分）` : ''}` : '給与計算のメール'
  if (review) return `${period}を受け取りましたが、自動取込を完了できませんでした。\n既存の給与データは変更していません。ZIPの内容・対象月・登録済みデータの確認が必要です。\n給与・勤務の検証結果: ${SITE}/admin/payroll-mail`
  const labels:Record<string,string>={calculation_settings_missing:'自社の計算設定なし',hourly_rate_missing:'時給設定不足',
    monthly_base_missing:'月給設定不足',deduction_settings_missing:'控除設定不足',labor_attendance_missing:'労務士資料の勤怠入力不足',
    labor_rate_missing:'労務士資料の単価不明',declared_rate_missing:'計算に必要な時給不明',deduction_items_missing:'当月の控除内訳不明',
    deduction_items_mismatch:'当月の控除内訳合計と総額の差',
    overtime_settings_missing:'残業設定不足',invalid_calculation:'計算値の確認不可',earning_items_difference:'基本給・残業明細の差'}
  const details=Object.entries(reasons).filter(([reason])=>reason!=='attendance_difference')
    .map(([reason,count])=>`${labels[reason]||'内容の確認が必要'} ${count}人`).join('、')
  const attendanceNote=reasons.attendance_difference?`\n参考: ${reasons.attendance_difference}人に労務士資料と実打刻の勤怠差があります。`:''
  return `${period}をTSGの給与・勤務に取り込みました。\n労務士資料の勤怠・記載単価を使った給与式比較: 対象 ${counts.employees}人、比較できた人数 ${counts.compared}人、給与式・控除内訳に差があった人数 ${counts.mismatches}人、確認できなかった人数 ${counts.unverified}人。${details?`\n確認が必要な内容: ${details}。`:''}${attendanceNote}\n実打刻による試算と勤怠差は参考欄に表示し、上の給与式比較の差異人数には含めません。\n固定給は保存済みの適用設定と照合し、設定がない場合は資料から補完します。手当は当月資料の内訳を使います。控除は当月資料の内訳合計と控除総額の照合で、税金・保険料の法定額を再計算した結果ではありません。入力を確認できない項目は一致に含めていません。\n${counts.mismatches || counts.unverified ? '差異や未確認の内容を給与・勤務の検証結果で確認してください。' : '比較できた範囲では差はありませんでした。'}\n給与・勤務の検証結果: ${SITE}/admin/payroll-mail`
}

async function recipientReady() {
  const configured = process.env.PAYROLL_MAIL_RECIPIENT_NAME?.trim()
  if (!configured || normalizeUserName(configured)!=='佐藤正彦' || !process.env.TSG_INTEGRATION_SECRET?.trim()) {
    throw new PayrollMailError('report_not_configured',503)
  }
  const {data,error}=await adminClient.from('gw_users').select('id,real_name,display_name,role').eq('status','approved')
  if(error) throw new PayrollMailError('storage_unavailable',503)
  const matches=(data||[]).filter(user => normalizeUserName(user.real_name||user.display_name)==='佐藤正彦')
  if(matches.length!==1 || getEffectiveUserRole(matches[0])!=='executive') throw new PayrollMailError('report_recipient_unavailable',503)
  return { id:matches[0].id, name:matches[0].real_name||matches[0].display_name }
}
export async function payrollMailReadiness() {
  await recipientReady()
  try { await checkPayrollArchiveStorage() } catch(error) {
    throw new PayrollMailError(error instanceof PayrollArchiveStorageError?error.code:'archive_storage_unavailable',503)
  }
  const {error}=await adminClient.from('gw_payroll_mail_sources').select('source_key').limit(1)
  if(error) throw new PayrollMailError('storage_unavailable',503)
  return { ok:true, ready:true }
}
async function jobForSource(sourceKey: string): Promise<Job|null> {
  const source=await adminClient.from('gw_payroll_mail_sources').select('job_id,message_id').eq('source_key',sourceKey).maybeSingle()
  if(source.error) throw new PayrollMailError('storage_unavailable',503)
  if(!source.data) return null
  const result=await adminClient.from('gw_payroll_mail_jobs').select('*').eq('id',source.data.job_id).single()
  if(result.error||!result.data) throw new PayrollMailError('storage_unavailable',503)
  return {...result.data,message_id:source.data.message_id} as Job
}
export function payrollMailReceipt(job: Job, sourceKey: string, messageId = job.message_id) {
  return {
    ok:true,status:job.status==='needs_review'?'needs_review':job.duplicate?'duplicate':'imported',
    sourceKey,messageId,sha256:job.zip_sha256,payrollMonth:job.payroll_month,attendanceMonth:job.attendance_month,
    batchId:job.batch_id,report:{status:job.report_status},counts:job.comparison?.counts||EMPTY_COUNTS,
  }
}
export async function getPayrollMailReceipt(sourceKey: string) {
  const job=await jobForSource(sourceKey)
  if(!job) throw new PayrollMailError('not_found',404)
  return payrollMailReceipt(job,sourceKey)
}
async function reportPendingJob(job: Job) {
  if(job.report_status==='sent') return job
  try {
    const recipient=await recipientReady()
    const response=await sendDirectMessage(new NextRequest(`${SITE}/api/integrations/tsa/direct-message`,{
      method:'POST',headers:{'content-type':'application/json','x-tsg-integration-secret':process.env.TSG_INTEGRATION_SECRET!.trim()},
      body:JSON.stringify({sourceKey:`payroll-mail:${job.id}:report:v1`,recipientName:recipient.name,content:job.report_content}),
    }))
    const result=await response.json()
    if(!response.ok || result.ok!==true || result.recipient?.id!==recipient.id || result.poster?.displayName!=='TSG君'
      || result.post?.content!==job.report_content || !result.post?.id) return job
    const {error}=await adminClient.from('gw_payroll_mail_jobs').update({report_status:'sent',report_post_id:result.post.id,reported_at:new Date().toISOString()})
      .eq('id',job.id).eq('report_status','pending')
    if(error) return job
    return {...job,report_status:'sent' as const}
  } catch { return job }
}
async function receive(payload: Record<string,unknown>) {
  const {data,error}=await adminClient.rpc('gw_receive_payroll_mail',{p_payload:payload})
  if(error||!data) throw new PayrollMailError(error?.code==='23505'?'source_conflict':'storage_unavailable',error?.code==='23505'?409:503)
  return data as Job
}
export async function processPayrollMail(input: PayrollMailInput) {
  if(input.mode==='initialize_storage') {
    await recipientReady()
    try {return {ok:true,...await initializePayrollArchiveStorage()}}
    catch(error) {throw new PayrollMailError(error instanceof PayrollArchiveStorageError?error.code:'archive_setup_failed',503)}
  }
  if(input.mode==='retry_report') {
    const job=await jobForSource(input.sourceKey)
    if(!job) throw new PayrollMailError('not_found',404)
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey)
  }
  const base = {
    mode:input.mode, sourceKey:input.sourceKey,messageId:input.messageId,attachmentId:input.attachmentId,
    sha256:input.sha256,payrollMonth:input.payrollMonth,attendanceMonth:input.attendanceMonth,fingerprint:fingerprint(input),
    reviewContent:buildPayrollMailReport(input.payrollMonth,input.attendanceMonth,EMPTY_COUNTS,true),
  }
  // Repeated source submissions must be checked by the RPC fingerprint before
  // any Drive upload or reanalysis; imported payroll is never regenerated.
  const previous=await jobForSource(input.sourceKey)
  if(previous) {
    const job=await receive({...base,reviewReason:input.mode==='review'?input.errorCode:null})
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
  }
  if(input.mode==='review') {
    const job=await receive({...base,reviewReason:input.errorCode,comparison:{counts:EMPTY_COUNTS}})
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
  }
  const existingHashJob=await adminClient.from('gw_payroll_mail_jobs').select('id')
    .eq('idempotency_key',`zip:${input.sha256}:${input.payrollMonth}:${input.attendanceMonth}`).maybeSingle()
  if(existingHashJob.error) throw new PayrollMailError('storage_unavailable',503)
  if(existingHashJob.data) {
    const job=await receive(base)
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
  }
  let archive:Awaited<ReturnType<typeof parsePayrollMailArchive>>
  let analysis:Awaited<ReturnType<typeof parseLaborPayrollZip>>
  try {
    archive=await parsePayrollMailArchive(input.buffer,{payrollMonth:input.payrollMonth,attendanceMonth:input.attendanceMonth})
    analysis=await parseLaborPayrollZip(archive.buffer)
  } catch {
    const job=await receive({...base,reviewReason:'unsupported_archive',comparison:{counts:EMPTY_COUNTS}})
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
  }
  const employees=await loadAllRows<EmployeeRow>((from,to)=>adminClient.from('gw_payroll_employees')
    .select('id,user_id,employee_code,display_name,real_name,payroll_status,raw_payload').order('id').range(from,to))
  let matches:ReturnType<typeof matchLaborPayrollEmployees>
  try { matches=matchLaborPayrollEmployees(analysis.results,employees) } catch {
    const job=await receive({...base,reviewReason:'employee_mapping',comparison:{counts:{...EMPTY_COUNTS,employees:analysis.results.length,unverified:analysis.results.length}}})
    return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
  }
  const ids=matches.map(match=>match.employee.id)
  const start=`${input.attendanceMonth}-01`
  const end=new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7)),0)).toISOString().slice(0,10)
  const [profiles,punches,leaves,policy]=await Promise.all([
    loadAllRows<MailComparisonProfile>((from,to)=>adminClient.from('gw_payroll_calculation_profiles').select('*').in('employee_id',ids)
      .lte('effective_from',`${input.payrollMonth}-01`).order('id').range(from,to)),
    loadAllRows<PunchLike & {employee_id:string}>((from,to)=>adminClient.from('gw_attendance_punches')
      .select('id,employee_id,punch_type,work_date,punched_at,break_override_minutes').in('employee_id',ids).eq('is_voided',false)
      .gte('work_date',start).lte('work_date',end).order('id').range(from,to)),
    loadAllRows<PaidLeavePaymentLike & {employee_id:string}>((from,to)=>adminClient.from('gw_paid_leave_requests')
      .select('id,employee_id,leave_date,leave_unit,requested_days,payable_minutes_snapshot,paid_wage_amount,raw_payload')
      .in('employee_id',ids).in('request_status',['approved','consumed']).gte('leave_date',start).lte('leave_date',end).order('id').range(from,to)),
    loadAttendanceCalculationPolicy(end),
  ])
  const rows=matches.map(({result,employee})=>comparePayrollMailEmployee({
    employeeId:employee.id,labor:result,profile:selectIndependentProfile(profiles,employee.id,`${input.payrollMonth}-01`),
    punches:punches.filter(row=>row.employee_id===employee.id),paidLeave:leaves.filter(row=>row.employee_id===employee.id),policy,
  }))
  const counts=payrollMailComparisonCounts(rows)
  let stability: Awaited<ReturnType<typeof loadPayrollRuleStability>> | {status:'unavailable';reason:string}
  try {
    stability=await loadPayrollRuleStability({month:`${input.payrollMonth}-01`,pending:matches.map(({result,employee})=>({employeeId:employee.id,labor:result}))})
  } catch {
    // A history-read failure must not lose a valid ZIP or masquerade as no drift.
    stability={status:'unavailable',reason:'history_unavailable'}
  }
  const stabilityNote=stability.status==='completed'
    ? `\n月次ロジック検証: 往復候補 ${stability.totals.ruleReversals}件、方式変更候補 ${stability.totals.ruleChanges}件、同一入力でのTSG計算結果変化 ${stability.totals.engineChanges+stability.totals.engineReversals}件。判別不能・資料不足は安定と断定していません。`
    : '\n月次ロジック検証: 履歴を取得できず未確認です。'
  const reasons=rows.reduce<Record<string,number>>((all,row)=>{
    if(row.reason) all[row.reason]=(all[row.reason]||0)+1
    return all
  },{})
  let drive:{id?:string|null;webViewLink?:string|null}={id:null}
  // Even when a completed manual batch is reused, retain this received ZIP
  // privately. Older manual archives may have had different sharing rules.
  try { drive=await uploadPayrollArchiveToDrive(input.buffer,`給与メール_${input.payrollMonth}_${input.sha256.slice(0,12)}.zip`) }
  catch { throw new PayrollMailError('archive_storage_unavailable',503) }
  if(!drive.id) throw new PayrollMailError('archive_storage_unavailable',503)
  const summary={source:'payroll_mail',analysisStage:'completed',requiresExtraction:false,verifiedAgainstWorkbookTotal:true,
    zipFileName:input.fileName,zipSha256:input.sha256,zipFileSize:input.buffer.length,zipDriveFileId:drive.id,
    zipDriveUrl:drive.webViewLink||null,sourceWorkbook:archive.statementWorkbook,wageLedgerWorkbook:archive.ledgerWorkbook,
    resultCount:counts.employees,paymentTotal:analysis.totals.paymentTotal,deductionTotal:analysis.totals.deductionTotal,
    netPayment:analysis.totals.netPayment,completedAt:new Date().toISOString(),profileUpdated:false,
  }
  const documents=[{path:input.fileName,name:input.fileName,extension:'.zip',size:input.buffer.length,sha256:input.sha256,
    documentType:'zip_package',status:'extracted',isStatement:false,summary:{zipDriveFileId:drive.id}},
    ...archive.entries.map(entry=>({path:`${input.fileName}/${entry.path}`,name:entry.name,
      extension:entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase(),size:entry.size,
      sha256:sha256(`${input.sha256}\n${entry.path}\n${entry.crc32}\n${entry.size}`),
      documentType:entry.path===archive.statementWorkbook||entry.path===archive.ledgerWorkbook?'payroll_statement':'unknown',
      status:entry.path===archive.statementWorkbook||entry.path===archive.ledgerWorkbook?'extracted':'partial',
      isStatement:entry.path===archive.statementWorkbook,summary:{entryPath:entry.path},
    }))]
  const job=await receive({...base,payDate:archive.payDate,summary,documents,totals:analysis.totals,
    results:matches.map(({result,employee})=>({...result,employeeId:employee.id,
      rawPayload:{source:'payroll_mail',employeeCode:result.employeeCode,sourceSheet:result.sourceSheet,verifiedAgainstWorkbookTotal:true}})),
    comparison:{counts,rows,reasons,archiveDriveFileId:drive.id,calculatedAt:new Date().toISOString(),version:2,
      basis:'labor_attendance_and_declared_rates',deductions:'labor_item_sum_not_tax_recalculation',stability},
    reportContent:buildPayrollMailReport(input.payrollMonth,input.attendanceMonth,counts,false,reasons)+stabilityNote+`\n月次ロジック検証: ${SITE}/admin/payroll-stability`,
  })
  return payrollMailReceipt(await reportPendingJob(job),input.sourceKey,input.messageId)
}
