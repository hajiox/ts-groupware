type RosterEmployee = {
  user_id: string | null
  display_name: string
  real_name: string | null
  hire_date: string | null
  payroll_status: string
  raw_payload: Record<string, unknown> | null
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined) {
  const value = rawPayload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function isConfirmedShiftRosterMember(options: {
  employee: RosterEmployee
  periodDepartment: string
  employeeDepartment: string | null
  periodEndDate: string
  excludedUserIds: ReadonlySet<string>
  rosterExcluded: boolean
}) {
  const { employee } = options
  const profile = hrProfile(employee.raw_payload)
  const provisional = profile.provisional_hire === true && profile.shift_visible_before_hire === true
  return Boolean(employee.user_id)
    && !profile.deleted_at
    && (employee.payroll_status === 'active' || provisional)
    && options.employeeDepartment === options.periodDepartment
    && (!employee.hire_date || employee.hire_date <= options.periodEndDate)
    && !options.excludedUserIds.has(employee.user_id!)
    && !options.rosterExcluded
}
