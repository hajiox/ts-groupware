import { getEffectiveUserRole, normalizeUserName, type UserRoleLike } from './user-roles'

export type AppraisalUser = UserRoleLike & { id: string; status?: string | null }
export function canReviewAppraisals(user: AppraisalUser | null) {
  return !!user && (!user.status || user.status === 'approved') && getEffectiveUserRole(user) !== 'member'
    && normalizeUserName(user.real_name || user.display_name) !== 'TSG君'
}
export function canAppraiseEmployee(user: AppraisalUser, employee: { id: string; user_id: string }, assignedEmployeeIds: Set<string>) {
  return canReviewAppraisals(user) && user.id !== employee.user_id
    && assignedEmployeeIds.has(employee.id)
}
