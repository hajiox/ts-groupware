export const REGULAR_EMPLOYEE_WORK_STYLES = [
  'regular_5d_8h',
  'regular_6d_6_5h',
] as const

export type BereavementRelationshipCode =
  | 'parent'
  | 'child'
  | 'grandparent'
  | 'grandchild'
  | 'sibling'
  | 'great_grandparent'
  | 'great_grandchild'
  | 'uncle_aunt'
  | 'nephew_niece'

export type BereavementRelationship = {
  code: BereavementRelationshipCode
  label: string
  degree: 1 | 2 | 3
  entitledDays: 7 | 3 | 1
}

export const BEREAVEMENT_RELATIONSHIPS: readonly BereavementRelationship[] = [
  { code: 'parent', label: '父母', degree: 1, entitledDays: 7 },
  { code: 'child', label: '子', degree: 1, entitledDays: 7 },
  { code: 'grandparent', label: '祖父母', degree: 2, entitledDays: 3 },
  { code: 'grandchild', label: '孫', degree: 2, entitledDays: 3 },
  { code: 'sibling', label: '兄弟姉妹', degree: 2, entitledDays: 3 },
  { code: 'great_grandparent', label: '曽祖父母', degree: 3, entitledDays: 1 },
  { code: 'great_grandchild', label: 'ひ孫', degree: 3, entitledDays: 1 },
  { code: 'uncle_aunt', label: '叔父・叔母', degree: 3, entitledDays: 1 },
  { code: 'nephew_niece', label: '甥・姪', degree: 3, entitledDays: 1 },
] as const

export const BEREAVEMENT_POLICY_ROWS = [
  { degree: '1親等', relationships: '父母・子', days: '7日' },
  { degree: '2親等', relationships: '祖父母・孫・兄弟姉妹', days: '3日' },
  { degree: '3親等', relationships: '曽祖父母・ひ孫・叔父叔母・甥姪', days: '1日' },
  { degree: '4親等', relationships: 'いとこ', days: '規定なし' },
] as const

export function isRegularEmployeeWorkStyle(value: string | null | undefined) {
  return REGULAR_EMPLOYEE_WORK_STYLES.includes(
    value as (typeof REGULAR_EMPLOYEE_WORK_STYLES)[number],
  )
}

export function getBereavementRelationship(value: unknown) {
  return BEREAVEMENT_RELATIONSHIPS.find((item) => item.code === value) || null
}

export function inclusiveCalendarDays(startDate: string, endDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return 0
  }
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
}
