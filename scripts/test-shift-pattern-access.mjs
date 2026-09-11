import assert from 'node:assert/strict'
import { canSelectAllShiftPatterns } from '../lib/shift-pattern-access.ts'

for (const department of ['フロア', '製造', '道の駅']) {
  for (const work_style of ['regular_5d_8h', 'regular_6d_6_5h', 'part_time_under_29_5h', 'full_time_part', null]) {
    const expected = department === 'フロア' || ['regular_5d_8h', 'regular_6d_6_5h'].includes(work_style)
    assert.equal(canSelectAllShiftPatterns({ department, work_style }), expected, `${department}/${work_style}`)
  }
}
console.log('Shift pattern access: 15 department/employment cases passed')
