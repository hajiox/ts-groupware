// Manual shift selection: floor staff share all department patterns.
export function canSelectAllShiftPatterns(employee: { department: string; work_style: string | null }) {
  return employee.department === 'フロア'
    || employee.work_style === 'regular_5d_8h'
    || employee.work_style === 'regular_6d_6_5h'
}
