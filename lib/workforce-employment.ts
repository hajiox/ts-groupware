import { adminClient } from '@/lib/supabase/admin'

export type WorkforceUser = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
  department?: string | null
  status?: string | null
}

export type WorkforceEmployee = {
  id?: string
  user_id: string | null
  employee_code?: string | null
  hire_date: string | null
  resigned_date: string | null
  department?: string | null
  payroll_status: string
}

const ATTENDANCE_EXCLUDED_NAMES = new Set([
  'TSG君',
  'TSGくん',
  '佐藤正彦',
  '佐藤ちさと',
])

function normalizePersonName(value: string | null | undefined) {
  return (value || '').replace(/[\s　]+/g, '')
}

export function isAttendanceWorkforceExcluded(user: WorkforceUser) {
  return [user.real_name, user.display_name]
    .map(normalizePersonName)
    .some((name) => ATTENDANCE_EXCLUDED_NAMES.has(name))
}

export function employmentOverlapsRange(
  employee: Pick<WorkforceEmployee, 'hire_date' | 'resigned_date'>,
  startDate: string,
  endDate: string,
) {
  return (!employee.hire_date || employee.hire_date <= endDate)
    && (!employee.resigned_date || employee.resigned_date >= startDate)
}

export function isEmployeePayrollEligibleForRange(
  employee: Pick<WorkforceEmployee, 'hire_date' | 'resigned_date' | 'payroll_status'>,
  startDate: string,
  endDate: string,
) {
  if (!employmentOverlapsRange(employee, startDate, endDate)) return false
  if (employee.payroll_status === 'retired') return Boolean(employee.resigned_date)
  return employee.payroll_status === 'active'
}

function isAttendanceUserForRange(
  user: WorkforceUser,
  employee: WorkforceEmployee | undefined,
  startDate: string,
  endDate: string,
) {
  if (employee?.payroll_status === 'retired') {
    return Boolean(employee.resigned_date) && employmentOverlapsRange(employee, startDate, endDate)
  }
  return (user.status || 'approved') === 'approved'
}

export async function loadAttendanceWorkforceForRange(options: {
  startDate: string
  endDate: string
  department?: string
}) {
  const [{ data: users, error: usersError }, { data: employees, error: employeesError }] = await Promise.all([
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, department, status')
      .order('department', { ascending: true })
      .order('display_name', { ascending: true }),
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, hire_date, resigned_date, department, payroll_status')
      .not('user_id', 'is', null),
  ])

  const error = usersError || employeesError
  if (error) return { users: [] as WorkforceUser[], employeesByUserId: new Map<string, WorkforceEmployee>(), error }

  const employeesByUserId = new Map<string, WorkforceEmployee>()
  for (const employee of (employees || []) as WorkforceEmployee[]) {
    if (employee.user_id) employeesByUserId.set(employee.user_id, employee)
  }

  const filteredUsers = ((users || []) as WorkforceUser[]).filter((user) => {
    if (isAttendanceWorkforceExcluded(user)) return false
    const employee = employeesByUserId.get(user.id)
    const department = user.department || employee?.department || null
    if (options.department && department !== options.department) return false
    return isAttendanceUserForRange(user, employee, options.startDate, options.endDate)
  })

  return { users: filteredUsers, employeesByUserId, error: null }
}

export async function isAttendanceUserEligibleForRange(userId: string, startDate: string, endDate: string) {
  const workforce = await loadAttendanceWorkforceForRange({ startDate, endDate })
  if (workforce.error) return { eligible: false, error: workforce.error }
  return {
    eligible: workforce.users.some((user) => user.id === userId),
    error: null,
  }
}
