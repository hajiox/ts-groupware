import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { getEffectiveUserRole, normalizeUserName } from '@/lib/user-roles'
import { canAppraiseEmployee, canReviewAppraisals, type AppraisalUser } from '@/lib/appraisal-access'
import { validAppraisalMonth, validateAppraisalInput } from '@/lib/appraisals'

const headers = { 'Cache-Control': 'private, no-store' }
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers })
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

async function context(user: AppraisalUser) {
  const executive = getEffectiveUserRole(user) === 'executive'
  const [employeesResult, usersResult, assignmentsResult] = await Promise.all([
    adminClient.from('gw_payroll_employees').select('id,user_id,real_name,display_name,department').eq('payroll_status','active'),
    adminClient.from('gw_users').select('id,real_name,display_name,role,status,department').eq('status','approved'),
    executive ? adminClient.from('gw_appraisal_assignments').select('reviewer_id,employee_id')
      : adminClient.from('gw_appraisal_assignments').select('reviewer_id,employee_id').eq('reviewer_id',user.id),
  ])
  if (employeesResult.error || usersResult.error || assignmentsResult.error) throw new Error('APPRAISAL_DATA_ERROR')
  const users = usersResult.data || []
  const assignments = assignmentsResult.data || []
  const assigned = new Set(assignments.filter(a => a.reviewer_id === user.id).map(a => a.employee_id as string))
  const eligible = (employeesResult.data || []).filter(employee => {
    const target = users.find(u => u.id === employee.user_id)
    return target && getEffectiveUserRole(target) === 'member' && normalizeUserName(target.real_name || target.display_name) !== 'TSG君'
  })
  const employees = eligible.filter(employee => canAppraiseEmployee(user,employee,assigned))
  const reviewers = users.filter(u => canReviewAppraisals(u)).map(u => ({ id:u.id, name:u.real_name || u.display_name, department:u.department }))
  return { executive, employees, reviewers, assignments, eligible, users }
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return reply({ error:'認証が必要です' },401)
  if (!canReviewAppraisals(user)) return reply({ error:'査定の管理権限が必要です' },403)
  const month = request.nextUrl.searchParams.get('month')
  if (!validAppraisalMonth(month)) return reply({ error:'対象月を正しく指定してください' },400)
  try {
    const ctx = await context(user)
    let query = adminClient.from('gw_employee_appraisals').select('id,reviewer_id,employee_id,period_month,assessed_on,ratings,status,version,updated_at,completed_at').eq('period_month',`${month}-01`)
    if (!ctx.executive) query = query.eq('reviewer_id',user.id)
    const { data, error } = await query
    if (error) throw new Error('APPRAISAL_DATA_ERROR')
    return reply({
      employees:ctx.employees.map(e => ({id:e.id,name:e.real_name || e.display_name,department:e.department})),
      assignableEmployees:ctx.executive ? ctx.eligible.map(e => ({id:e.id,name:e.real_name || e.display_name,department:e.department})) : [],
      records:ctx.executive ? data : (data || []).filter(r => ctx.employees.some(e => e.id === r.employee_id)),
      reviewer:{id:user.id,name:user.real_name || user.display_name,department:user.department},
      reviewers:ctx.executive ? ctx.reviewers : [], executive:ctx.executive,
      assignments:ctx.executive ? ctx.assignments : [],
    })
  } catch { return reply({ error:'査定情報を取得できませんでした。管理者にご連絡ください。' },500) }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return reply({ error:'認証が必要です' },401)
  if (!canReviewAppraisals(user)) return reply({ error:'査定の管理権限が必要です' },403)
  let body: Record<string,unknown>
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw,'utf8') > 100000) return reply({error:'入力が大きすぎます'},413)
    body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch { return reply({error:'入力形式が不正です'},400) }
  if (!uuid(body.employeeId)) return reply({error:'査定対象者が不正です'},400)
  try {
    const ctx = await context(user)
    if (body.action === 'assign' || body.action === 'unassign') {
      if (!ctx.executive) return reply({error:'担当設定は役員のみ変更できます'},403)
      if (!uuid(body.reviewerId) || !ctx.reviewers.some(r => r.id === body.reviewerId)) return reply({error:'査定者が不正です'},400)
      const target = ctx.eligible.find(e => e.id === body.employeeId)
      if (!target || target.user_id === body.reviewerId) return reply({error:'本人を担当には設定できません'},400)
      const result = body.action === 'assign'
        ? await adminClient.from('gw_appraisal_assignments').upsert({reviewer_id:body.reviewerId,employee_id:body.employeeId,assigned_by:user.id},{onConflict:'reviewer_id,employee_id'})
        : await adminClient.from('gw_appraisal_assignments').delete().eq('reviewer_id',body.reviewerId).eq('employee_id',body.employeeId)
      if (result.error) throw new Error('APPRAISAL_DATA_ERROR')
      return reply({ok:true})
    }
    if (!ctx.employees.some(e => e.id === body.employeeId)) return reply({error:'担当する部下のみ査定できます'},403)
    let input
    try { input = validateAppraisalInput(body) }
    catch(e) { return reply({error:e instanceof Error ? e.message : '入力が不正です'},400) }
    const {data,error} = await adminClient.rpc('gw_save_employee_appraisal',{
      p_reviewer:user.id,p_employee:body.employeeId,p_month:`${input.month}-01`,p_assessed_on:input.assessedOn,
      p_ratings:input.ratings,p_status:input.status,p_version:input.version,
    })
    if (error?.message?.includes('APPRAISAL_CONFLICT')) return reply({error:'他の画面で更新されています。入力内容を控えてから画面を再読み込みしてください。'},409)
    if (error) throw new Error('APPRAISAL_DATA_ERROR')
    return reply({ok:true,record:data})
  } catch { return reply({error:'保存できませんでした。入力を保持したまま再試行できます。'},500) }
}
