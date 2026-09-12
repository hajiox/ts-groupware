import assert from 'node:assert/strict'

import {
  isWaitingForNewHireMessage,
  japanToday,
} from '../lib/new-hire-company-message-schedule.ts'

assert.equal(isWaitingForNewHireMessage('2026-09-01', '2026-09-07'), true)
assert.equal(isWaitingForNewHireMessage('2026-09-01', '2026-09-08'), false)
assert.equal(isWaitingForNewHireMessage('2026-09-01', '2026-09-09'), false)
assert.equal(isWaitingForNewHireMessage(null, '2026-09-08'), false)
assert.equal(isWaitingForNewHireMessage('invalid', '2026-09-08'), false)
assert.equal(japanToday(new Date('2026-09-11T15:05:00.000Z')), '2026-09-12')

console.log('new hire company message schedule checks passed')
