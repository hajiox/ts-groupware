import assert from 'node:assert/strict'

import {
  isShiftRequestCollectionExcluded,
  isShiftRosterExcluded,
} from '../lib/shift-request-exclusions.ts'

const satoMasahiko = { display_name: '佐藤 正彦', real_name: '佐藤正彦' }

assert.equal(isShiftRequestCollectionExcluded(satoMasahiko), true)
assert.equal(isShiftRosterExcluded(satoMasahiko), false)
assert.equal(isShiftRosterExcluded({ display_name: 'TSG君' }), true)
assert.equal(isShiftRequestCollectionExcluded({ display_name: '佐藤 ちさと' }), false)

console.log('shift request exclusion checks passed')
