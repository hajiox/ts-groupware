export const USER_ROLES = ['executive', 'admin', 'member'] as const

export type UserRole = (typeof USER_ROLES)[number]

export type UserRoleLike = {
  role?: string | null
  display_name?: string | null
  real_name?: string | null
}

export const EXECUTIVE_NAMES = ['佐藤正彦', '佐藤ちさと'] as const

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  executive: '役員',
  admin: '管理者',
  member: 'ユーザー',
}

export const USER_ROLE_OPTIONS = USER_ROLES.map((value) => ({
  value,
  label: USER_ROLE_LABELS[value],
}))

export function normalizeUserName(value: string | null | undefined) {
  return (value || '').replace(/[\s　]+/g, '').trim()
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole)
}

export function isFixedExecutiveUser(user: UserRoleLike | null | undefined) {
  if (!user) return false
  const executiveNames = EXECUTIVE_NAMES.map(normalizeUserName)
  return [user.real_name, user.display_name]
    .map(normalizeUserName)
    .filter(Boolean)
    .some((name) => executiveNames.includes(name as (typeof executiveNames)[number]))
}

export function getEffectiveUserRole(user: UserRoleLike | null | undefined): UserRole {
  if (user?.role === 'executive' || isFixedExecutiveUser(user)) return 'executive'
  if (user?.role === 'admin') return 'admin'
  return 'member'
}

export function getUserRoleLabel(user: UserRoleLike | null | undefined) {
  return USER_ROLE_LABELS[getEffectiveUserRole(user)]
}

export function isManagementRole(role: string | null | undefined) {
  return role === 'executive' || role === 'admin'
}

export function isManagementUser(user: UserRoleLike | null | undefined) {
  return isManagementRole(getEffectiveUserRole(user))
}

export function isExecutiveUser(user: UserRoleLike | null | undefined) {
  return getEffectiveUserRole(user) === 'executive'
}

export function userRoleRank(user: UserRoleLike | null | undefined) {
  const role = getEffectiveUserRole(user)
  if (role === 'executive') return 0
  if (role === 'admin') return 1
  return 2
}
