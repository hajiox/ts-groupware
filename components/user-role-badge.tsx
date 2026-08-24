import { Crown, ShieldCheck, UserRound } from 'lucide-react'
import {
  getEffectiveUserRole,
  USER_ROLE_LABELS,
  type UserRole,
  type UserRoleLike,
} from '@/lib/user-roles'

const ROLE_ICONS = {
  executive: Crown,
  admin: ShieldCheck,
  member: UserRound,
} satisfies Record<UserRole, typeof Crown>

type UserRoleIconProps = {
  role: UserRole
  size?: number
  showLabel?: boolean
  className?: string
}

export function UserRoleIcon({
  role,
  size = 16,
  showLabel = false,
  className = '',
}: UserRoleIconProps) {
  const Icon = ROLE_ICONS[role]
  const label = USER_ROLE_LABELS[role]

  return (
    <span
      className={`user-role-icon user-role-icon--${role} ${className}`.trim()}
      title={label}
      aria-label={label}
    >
      <Icon size={size} strokeWidth={2} aria-hidden="true" />
      {showLabel && <span>{label}</span>}
    </span>
  )
}

export function UserRoleBadge({ user }: { user: UserRoleLike | null | undefined }) {
  return <UserRoleIcon role={getEffectiveUserRole(user)} showLabel />
}

export function RoleAccessIcons({ roles }: { roles: readonly UserRole[] }) {
  return (
    <span className="role-access-icons" aria-label={`利用可能: ${roles.map((role) => USER_ROLE_LABELS[role]).join('、')}`}>
      {roles.map((role) => (
        <UserRoleIcon key={role} role={role} size={14} />
      ))}
    </span>
  )
}
