export const USER_DEPARTMENTS = ["フロア", "製造", "道の駅"] as const;

export type UserDepartment = (typeof USER_DEPARTMENTS)[number];

export const DEFAULT_USER_DEPARTMENT: UserDepartment = "製造";

export function isUserDepartment(value: unknown): value is UserDepartment {
  return typeof value === "string" && USER_DEPARTMENTS.includes(value as UserDepartment);
}

export function normalizeUserDepartment(value: unknown): UserDepartment {
  return isUserDepartment(value) ? value : DEFAULT_USER_DEPARTMENT;
}
