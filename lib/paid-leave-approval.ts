import { adminClient } from '@/lib/supabase/admin'
import { getEffectiveUserRole, normalizeUserName } from '@/lib/user-roles'

type UserLike = {
  id?: string | null
  role?: string | null
  display_name?: string | null
  real_name?: string | null
  department?: string | null
  status?: string | null
}

type EmployeeLike = {
  id: string
  user_id?: string | null
  department?: string | null
}

const PRESIDENT_NAME = normalizeUserName('佐藤正彦')
const SYSTEM_USER_NAMES = new Set(['TSG君', 'TSGくん', 'TSG'].map(normalizeUserName))

export function isPaidLeavePresident(user: UserLike | null | undefined) {
  return [user?.real_name, user?.display_name]
    .map(normalizeUserName)
    .some((name) => name === PRESIDENT_NAME)
}

export function canReceivePaidLeaveApprovals(user: UserLike | null | undefined) {
  const names = [user?.real_name, user?.display_name].map(normalizeUserName)
  if (names.some((name) => SYSTEM_USER_NAMES.has(name))) return false
  return isPaidLeavePresident(user) || ['admin', 'executive'].includes(getEffectiveUserRole(user))
}

async function activeUsers() {
  const { data, error } = await adminClient
    .from('gw_users')
    .select('id, role, display_name, real_name, department, status')
    .eq('status', 'approved')
  if (error) throw error
  return (data || []) as UserLike[]
}

async function employeeById(employeeId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, department')
    .eq('id', employeeId)
    .maybeSingle()
  if (error) throw error
  return data as EmployeeLike | null
}

export async function paidLeaveApproverIdsForEmployee(employeeId: string) {
  const [employee, users] = await Promise.all([employeeById(employeeId), activeUsers()])
  if (!employee?.user_id) return []

  const applicant = users.find((user) => user.id === employee.user_id)
  const president = users.find(isPaidLeavePresident)
  const applicantRole = getEffectiveUserRole(applicant)

  if (applicantRole === 'admin' || applicantRole === 'executive') {
    return president?.id && president.id !== employee.user_id ? [president.id] : []
  }

  const department = employee.department || applicant?.department || null
  const departmentManagerIds = users
    .filter((user) => (
      user.id !== employee.user_id
      && canReceivePaidLeaveApprovals(user)
      && !isPaidLeavePresident(user)
      && Boolean(department)
      && user.department === department
    ))
    .map((user) => user.id)
    .filter((id): id is string => Boolean(id))

  // 所属長が未設定でも申請が宙に浮かないよう、社長へフォールバックする。
  if (departmentManagerIds.length > 0) return [...new Set(departmentManagerIds)]
  return president?.id && president.id !== employee.user_id ? [president.id] : []
}

export async function canApprovePaidLeaveEmployee(user: UserLike, employeeId: string) {
  if (!user.id || !canReceivePaidLeaveApprovals(user)) return false
  const approverIds = await paidLeaveApproverIdsForEmployee(employeeId)
  return approverIds.includes(user.id)
}

export async function canRegisterPaidLeaveForEmployee(user: UserLike, employeeId: string) {
  if (!user.id || !canReceivePaidLeaveApprovals(user)) return false
  if (isPaidLeavePresident(user)) return true
  return canApprovePaidLeaveEmployee(user, employeeId)
}

export async function canApprovePaidLeaveRequest(user: UserLike, requestId: string) {
  if (!user.id || !requestId) return false
  const { data, error } = await adminClient
    .from('gw_paid_leave_requests')
    .select('employee_id, request_status')
    .eq('id', requestId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.request_status !== 'submitted') return false
  return canApprovePaidLeaveEmployee(user, data.employee_id)
}
