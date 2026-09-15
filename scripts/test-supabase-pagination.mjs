import assert from 'node:assert/strict'

import { loadAllRows } from '../lib/supabase-pagination.ts'

const source = Array.from({ length: 2017 }, (_, index) => ({ id: index + 1 }))
const calls = []
const rows = await loadAllRows(async (from, to) => {
  calls.push([from, to])
  return { data: source.slice(from, to + 1), error: null }
})

assert.deepEqual(rows, source)
assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]])

const queryError = new Error('query failed')
await assert.rejects(
  loadAllRows(async () => ({ data: null, error: queryError })),
  queryError,
)

console.log('supabase pagination checks passed')
