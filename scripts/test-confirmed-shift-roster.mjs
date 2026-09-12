import assert from 'node:assert/strict'

import { isConfirmedShiftRosterMember } from '../lib/confirmed-shift-roster.ts'

const baseEmployee = {
  user_id: 'sato',
  display_name: '佐藤 正彦',
  real_name: '佐藤正彦',
  hire_date: '2020-01-01',
  payroll_status: 'active',
  raw_payload: null,
}
const baseOptions = {
  employee: baseEmployee,
  periodDepartment: '道の駅',
  employeeDepartment: '道の駅',
  periodEndDate: '2026-09-15',
  excludedUserIds: new Set(),
  rosterExcluded: false,
}

assert.equal(isConfirmedShiftRosterMember(baseOptions), true)
assert.equal(isConfirmedShiftRosterMember({ ...baseOptions, excludedUserIds: new Set(['sato']) }), false)
assert.equal(isConfirmedShiftRosterMember({ ...baseOptions, employeeDepartment: 'フロア' }), false)
assert.equal(isConfirmedShiftRosterMember({
  ...baseOptions,
  employee: { ...baseEmployee, hire_date: '2026-09-16' },
}), false)
assert.equal(isConfirmedShiftRosterMember({
  ...baseOptions,
  rosterExcluded: true,
}), false)

console.log('confirmed shift roster checks passed')
