import { adminClient } from '@/lib/supabase/admin'
import {
  getEffectiveUserRole,
  isExecutiveUser,
  normalizeUserName,
} from '@/lib/user-roles'

type UserLike = {
  id?: string | null
  role?: string | null
  display_name?: string | null
  real_name?: string | null
}

const PAID_LEAVE_EXCLUDED_NAMES = ['佐藤正彦', '佐藤ちさと', 'TSG君']

export function isPayrollManager(user: UserLike | null | undefined) {
  return isExecutiveUser(user)
}

export async function hasFeatureRole(
  user: UserLike | null | undefined,
  featureKey: string,
  roleKey: string,
) {
  if (!user?.id) return false

  const { data, error } = await adminClient
    .from('gw_feature_roles')
    .select('id')
    .eq('feature_key', featureKey)
    .eq('role_key', roleKey)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return false

  return Boolean(data)
}

export async function canProxyStaffView(user: UserLike | null | undefined) {
  return isExecutiveUser(user)
}

export function getManagementPermissions(user: UserLike | null | undefined) {
  const accessLevel = getEffectiveUserRole(user)
  const canManage = accessLevel === 'executive' || accessLevel === 'admin'
  const canViewPayroll = accessLevel === 'executive'
  const userNames = [
    normalizeUserName(user?.real_name),
    normalizeUserName(user?.display_name),
  ].filter(Boolean)
  const canUsePersonalLeave = Boolean(user) && !userNames.some((name) => (
    PAID_LEAVE_EXCLUDED_NAMES.includes(name)
  ))
  const canUseManual = Boolean(user)

  return {
    accessLevel,
    canUseAdmin: canManage || canUsePersonalLeave || canUseManual,
    canManageUsers: canManage,
    canManageGroups: canManage,
    canManageAttendance: canManage,
    canViewPayroll,
    canUsePersonalLeave,
    canUseManual,
  }
}
