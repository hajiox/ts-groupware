const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => dependencies[name] || require(name))
  return loaded.exports
}
class FakeNextResponse extends Response {
  static json(body, init) { return new FakeNextResponse(JSON.stringify(body), init) }
}
const context = load('lib/business-api/context.ts')
const http = load('lib/data-api-http.ts', { 'next/server': { NextResponse: FakeNextResponse } })
const operations = [
  { id: 'fixture.read', area: 'fixture', readOnly: true },
  { id: 'fixture.write', area: 'fixture', readOnly: false },
]
const principal = { id: crypto.randomUUID(), role: 'executive', status: 'approved', display_name: 'Synthetic user' }
let authError = null, finishFailure = false, dispatchFailure = false
let result = { status: 200, body: { saved: true } }
let dispatchCalls = 0
const reservations = new Map()
const calls = []
const client = {
  from(table) {
    assert.equal(table, 'gw_users')
    return { select: () => ({ eq: (_field, id) => ({ single: async () => ({ data: principal?.id === id ? { ...principal } : null, error: null }) }) }) }
  },
  async rpc(name, args) {
    calls.push({ name, args })
    if (name === 'gw_business_api_authenticate') return { data: authError ? null : { connectionId: 'synthetic-connection', principalUserId: principal?.id, pcName: 'SyntheticPC' }, error: authError && { message: authError } }
    if (name === 'gw_business_api_begin') {
      const previous = reservations.get(args.p_idempotency_key)
      if (previous && previous.hash !== args.p_request_hash) return { data: null, error: { message: 'IDEMPOTENCY_CONFLICT' } }
      if (previous) return { data: previous.completed ? { state: 'completed', status: previous.status, response: previous.response } : { state: 'pending' }, error: null }
      reservations.set(args.p_idempotency_key, { hash: args.p_request_hash, requestId: args.p_request_id })
      return { data: { state: 'started' }, error: null }
    }
    if (name === 'gw_business_api_finish') {
      if (finishFailure) return { data: null, error: { message: 'INTERNAL' } }
      const row = [...reservations.values()].find(item => item.requestId === args.p_request_id)
      assert.equal(row.hash, args.p_request_hash)
      Object.assign(row, { completed: true, response: args.p_response, status: args.p_status })
      return { data: true, error: null }
    }
    throw new Error('Unexpected RPC')
  },
}
const gateway = load('lib/business-api/gateway.ts', {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/supabase/admin': { adminClient: client },
  '@/lib/data-api-http': http,
  '@/lib/line-picture': { normalizeLinePictureUrl: value => value },
  '@/lib/business-api/context': context,
  '@/lib/business-api/catalog': { getBusinessOperation: id => operations.find(item => item.id === id), listBusinessOperations: () => operations },
  '@/lib/business-api/dispatch': { dispatchBusinessOperation: async (id, input) => {
    dispatchCalls++
    assert.equal(context.getBusinessContext().user.id, principal.id)
    assert.equal(context.getBusinessContext().pcName, 'SyntheticPC')
    assert.ok(id && input)
    if (dispatchFailure) throw new Error('Synthetic timeout after side effect')
    return result
  } },
})
async function call(body) {
  const response = await gateway.executeBusinessOperation('a'.repeat(64), body, crypto.randomUUID())
  return { status: response.status, body: await response.json() }
}
const write = (key, body = { a: 1, b: 2 }) => ({ operation: 'business.write', input: { operationId: 'fixture.write', body }, idempotencyKey: key })

;(async () => {
  let output = await call({ operation: 'business.operations', input: { area: 'fixture' } })
  assert.equal(output.body.data.operations.length, 2)
  authError = 'UNAUTHORIZED'
  output = await call({ operation: 'business.read', input: { operationId: 'fixture.read' } })
  assert.equal(output.status, 401)
  authError = null
  principal.role = 'member'
  assert.equal((await call({ operation: 'business.operations', input: {} })).status, 401)
  principal.role = 'executive'
  const before = dispatchCalls
  assert.equal((await call({ operation: 'business.read', input: { operationId: 'fixture.write' } })).status, 400)
  assert.equal((await call({ operation: 'business.write', input: { operationId: 'fixture.read' }, idempotencyKey: 'mismatch-key' })).status, 400)
  assert.equal((await call({ operation: 'business.read', input: { operationId: '../../arbitrary' } })).status, 400)
  assert.equal(dispatchCalls, before)
  result = { status: 201, body: { id: 'synthetic', token: 'never-return', content: `text tsg_data_${'a'.repeat(43)}` } }
  output = await call(write('synthetic-key-1'))
  assert.equal(output.status, 201)
  assert.equal(output.body.data.body.token, '[redacted]')
  assert.equal(output.body.data.body.content, 'text [redacted]')
  const after = dispatchCalls
  output = await call(write('synthetic-key-1', { b: 2, a: 1 }))
  assert.equal(output.status, 201)
  assert.equal(dispatchCalls, after, 'Reordered equivalent JSON must replay without executing')
  output = await call(write('synthetic-key-1', { a: 2 }))
  assert.equal(output.status, 409)
  assert.equal(output.body.error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(dispatchCalls, after)
  dispatchFailure = true
  output = await call(write('synthetic-timeout'))
  assert.equal(output.body.error.code, 'WRITE_PENDING')
  dispatchFailure = false
  const afterTimeout = dispatchCalls
  assert.equal((await call(write('synthetic-timeout'))).body.error.code, 'WRITE_PENDING')
  assert.equal(dispatchCalls, afterTimeout)
  result = { status: 500, body: { error: 'Synthetic partial failure' } }
  assert.equal((await call(write('synthetic-500'))).body.error.code, 'WRITE_PENDING')
  assert.equal(reservations.get('synthetic-500').completed, undefined)
  result = { status: 200, body: { saved: true } }
  finishFailure = true
  assert.equal((await call(write('synthetic-finish-failure'))).body.error.code, 'WRITE_PENDING')
  finishFailure = false
  assert.equal(reservations.get('synthetic-finish-failure').completed, undefined)
  result = { status: 409, body: { error: 'Synthetic concurrent update' } }
  output = await call(write('synthetic-conflict'))
  assert.equal(output.body.error.message, 'Synthetic concurrent update')
  assert.equal(reservations.get('synthetic-conflict').completed, true)
  const afterConflict = dispatchCalls
  await call(write('synthetic-conflict'))
  assert.equal(dispatchCalls, afterConflict)
  result = { status: 200, file: { name: 'synthetic.pdf', type: 'application/pdf', base64: 'JVBERi0=' } }
  output = await call({ operation: 'business.read', input: { operationId: 'fixture.read' } })
  assert.equal(output.body.data.file.name, 'synthetic.pdf')
  assert.equal(context.getBusinessContext(), undefined)
  const a = { connectionId: 'A', pcName: 'A', user: { id: 'A' } }, b = { connectionId: 'B', pcName: 'B', user: { id: 'B' } }
  await Promise.all([a, b].map(value => context.runWithBusinessContext(value, async () => {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(context.getBusinessContext().connectionId, value.connectionId)
  })))
  assert.equal(context.getBusinessContext(), undefined, 'Business principal must not leak into normal sessions')
  const session = load('lib/session.ts', {
    'next/headers': { cookies: async () => { throw new Error('Business calls must not fabricate or read a cookie') } },
    '@/lib/session-cookie': {}, '@/lib/supabase/admin': { adminClient: client },
    '@/lib/line-picture': {}, '@/lib/business-api/context': context,
  })
  assert.equal(await context.runWithBusinessContext(a, () => session.getUserSession()), a.user)
  assert.ok(calls.every(item => !JSON.stringify(item.args).includes('never-return')))
  console.log('Business MCP gateway: authorization, existing principal, durable claims/replay, uncertain writes, redaction, binary files and isolated sessions passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
