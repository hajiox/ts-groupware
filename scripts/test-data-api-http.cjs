const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const groupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const confirmationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const token = `tsg_data_${'a'.repeat(43)}`
const baseUrl = 'https://tsg-test.invalid'
const now = Date.UTC(2026, 9, 7, 0, 0, 0)
const originalNow = Date.now
const originalWarn = console.warn
const warnings = []
Date.now = () => now
console.warn = (...args) => warnings.push(args)

function load(relativePath, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports,
    (name) => dependencies[name] || require(name))
  return loaded.exports
}
class FakeNextResponse extends Response {
  static json(value, init) { return new FakeNextResponse(JSON.stringify(value), init) }
}
const policy = load('lib/data-api-policy.ts')
const http = load('lib/data-api-http.ts', { 'next/server': { NextResponse: FakeNextResponse } })
let currentUser = { id: actorId, role: 'executive', status: 'approved' }
let sessionError = null
let rpcResult = { data: { ok: true, data: { items: [] } }, error: null }
let rpcError = null
const rpcCalls = []
const dependencies = {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/data-api-policy': policy,
  '@/lib/data-api-http': http,
  '@/lib/session': { getUserSession: async () => {
    if (sessionError) throw sessionError
    return currentUser
  } },
  '@/lib/supabase/admin': { adminClient: { rpc: async (name, args) => {
    rpcCalls.push({ name, args })
    if (rpcError) throw rpcError
    return rpcResult
  } } },
}
const execute = load('app/api/data/v1/execute/route.ts', dependencies)
const admin = load('app/api/admin/data-connections/route.ts', dependencies)

function request(body, options = {}) {
  const method = options.method || 'POST'
  const url = new URL(options.path || '/api/data/v1/execute', baseUrl)
  const headers = new Headers(options.headers === undefined
    ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    : options.headers)
  const init = { method, headers }
  if (method !== 'GET') init.body = options.raw === undefined ? JSON.stringify(body) : options.raw
  const result = new Request(url, init)
  result.nextUrl = url
  return result
}
function adminRequest(body, options = {}) {
  return request(body, {
    path: '/api/admin/data-connections',
    headers: { origin: baseUrl, 'content-type': 'application/json' }, ...options,
  })
}
async function failure(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, code)
  assert.equal(typeof body.error.message, 'string')
  assert.match(body.requestId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'requestId'])
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message'])
  return body
}
function validOperation(operation) {
  let input = {}
  if (operation.endsWith('.get') || operation === 'tasks.complete' || operation.startsWith('posts.publish.')) input = { id: itemId }
  if (operation === 'drafts.create') input = { group_id: groupId, content: ' 作成内容\n改行も維持 ' }
  if (operation === 'drafts.update') input = { id: itemId, content: ' 更新内容\n改行も維持 ' }
  const body = { operation, input }
  if (!policy.DATA_READ_SCOPES.includes(operation)) body.idempotencyKey = 'test-idempotency-0001'
  if (['drafts.update', 'tasks.complete', ...policy.DATA_PUBLISH_SCOPES].includes(operation)) body.expectedVersion = 'version:0001'
  if (operation === 'posts.publish.commit') body.confirmationId = confirmationId
  return body
}
const createBody = () => ({
  action: 'create', label: ' 試験接続 ', scopes: ['boards.list', 'posts.search'],
  allowedGroupIds: [groupId], expiresAt: new Date(now + 86400000).toISOString(), maxLimit: 20,
})

async function main() {
  // Only the dedicated bearer credential can reach the data RPC.
  for (const headers of [
    {}, { cookie: `gw_user_session=${actorId}` },
    { 'x-tsg-integration-secret': 'test-only-bridge-secret' },
    { authorization: 'Bearer test-only-bridge-secret' },
    { authorization: `Bearer tsg_data_${'a'.repeat(39)}` },
    { authorization: `Bearer tsg_data_${'a'.repeat(129)}` },
    { authorization: `Basic ${token}` }, { authorization: `Bearer ${token} extra` },
  ]) {
    const req = request({ operation: 'boards.list' }, { headers })
    const before = rpcCalls.length
    await failure(await execute.POST(req), 401, 'UNAUTHORIZED')
    assert.equal(rpcCalls.length, before)
    assert.equal(req.bodyUsed, false, 'Authentication fails before reading an untrusted request body')
  }

  for (const operation of policy.DATA_OPERATIONS) {
    const body = validOperation(operation)
    const response = await execute.POST(request(body))
    assert.equal(response.status, 200, operation)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).ok, true)
    const call = rpcCalls.at(-1)
    assert.equal(call.name, 'gw_data_api_execute')
    assert.equal(call.args.p_token_hash, crypto.createHash('sha256').update(token).digest('hex'))
    assert.equal(call.args.p_operation, operation)
    assert.deepEqual(call.args.p_args, body.input)
    assert.equal(call.args.p_idempotency_key, body.idempotencyKey || null)
    assert.equal(call.args.p_expected_version, body.expectedVersion || null)
    assert.equal(call.args.p_confirmation_id, body.confirmationId || null)
    assert.ok(!JSON.stringify(call.args).includes(token), 'Only a credential hash reaches the RPC')
  }

  for (const operation of ['boards.list','posts.search','knowledge.search','drafts.list','tasks.search']) {
    for (const offset of [0, 20, 10000]) {
      const response = await execute.POST(request({ operation, input: { offset } }));
      assert.equal(response.status, 200);
      assert.deepEqual(rpcCalls.at(-1).args.p_args, { offset });
    }
    for (const offset of [-1, 1.5, 10001, '20', null]) {
      const count = rpcCalls.length;
      await failure(await execute.POST(request({ operation, input: { offset } })), 400, 'VALIDATION');
      assert.equal(rpcCalls.length, count);
    }
  }

  const invalidBodies = [null, [], {}, { operation: 'sql.execute', input: { query: 'select 1' } },
    { operation: '__proto__' }, { operation: 'posts.delete', input: { id: itemId } },
    { operation: 'boards.list', user_id: actorId }, { operation: 'posts.search', input: { sql: 'select 1' } },
    { operation: 'posts.search', input: { principal_user_id: actorId } },
    { operation: 'posts.search', input: { query: 'a'.repeat(257) } },
    { operation: 'posts.search', input: { query: 'invalid\0query' } },
    { operation: 'posts.get', input: { id: 'invalid' } },
    { operation: 'posts.get', input: { id: itemId, table: 'gw_users' } },
    { operation: 'boards.list', idempotencyKey: 'not-read-key' },
    { operation: 'boards.list', expectedVersion: 'version:0001' },
    { operation: 'boards.list', confirmationId },
  ]
  for (const limit of [0, -1, 1.5, 21, '20', null]) invalidBodies.push({ operation: 'posts.search', input: { limit } })
  for (const content of ['', ' \n　', 'a'.repeat(4001), 'invalid\0content']) {
    invalidBodies.push({ ...validOperation('drafts.create'), input: { group_id: groupId, content } })
  }
  for (const operation of policy.DATA_OPERATIONS.filter((op) => !policy.DATA_READ_SCOPES.includes(op))) {
    const body = validOperation(operation)
    const withoutKey = { ...body }
    delete withoutKey.idempotencyKey
    invalidBodies.push(withoutKey, { ...body, idempotencyKey: 'short' }, { ...body, idempotencyKey: 'bad/key/0001' })
  }
  for (const operation of ['drafts.update', 'tasks.complete', ...policy.DATA_PUBLISH_SCOPES]) {
    const body = validOperation(operation)
    const withoutVersion = { ...body }
    delete withoutVersion.expectedVersion
    invalidBodies.push(withoutVersion, { ...body, expectedVersion: '' }, { ...body, expectedVersion: 'bad\nversion' },
      { ...body, expectedVersion: 'v'.repeat(81) })
  }
  const commit = validOperation('posts.publish.commit')
  const withoutConfirmation = { ...commit }
  delete withoutConfirmation.confirmationId
  invalidBodies.push(withoutConfirmation, { ...commit, confirmationId: 'invalid' },
    { ...validOperation('posts.publish.prepare'), confirmationId })
  for (const body of invalidBodies) {
    const before = rpcCalls.length
    await failure(await execute.POST(request(body)), 400, 'VALIDATION')
    assert.equal(rpcCalls.length, before, 'Invalid requests fail before executing a database operation')
  }
  for (const options of [
    { raw: '{' }, { raw: ' '.repeat(32769) },
    { raw: JSON.stringify({ operation: 'boards.list' }), headers: { authorization: `Bearer ${token}`, 'content-length': '32769' } },
  ]) await failure(await execute.POST(request(null, options)), 400, 'VALIDATION')

  assert.deepEqual(await http.readDataBody(request(null, { raw: '{}' + ' '.repeat(32766) })), {})
  let cancelled = false
  const overflow = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(20000)) },
    cancel() { cancelled = true },
  })
  const overflowRequest = new Request(`${baseUrl}/test`, { method: 'POST', body: overflow, duplex: 'half' })
  await assert.rejects(http.readDataBody(overflowRequest), /VALIDATION/)
  assert.equal(cancelled, true, 'An oversized streamed request must be cancelled')
  assert.equal(overflowRequest.body.locked, false, 'Release the reader lock after rejecting the stream')
  await assert.rejects(http.readDataBody(new Request(`${baseUrl}/test`)), /VALIDATION/)
  const invalidUtf8 = Buffer.concat([Buffer.from('{"content":"'), Buffer.from([0xff]), Buffer.from('"}')])
  await assert.rejects(http.readDataBody(request(null, { raw: invalidUtf8 })), /VALIDATION/)

  const statusCodes = { UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 400, NOT_FOUND: 404,
    CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, CONFIRMATION_REQUIRED: 409, RATE_LIMITED: 429 }
  for (const [code, status] of Object.entries(statusCodes)) {
    rpcResult = { data: null, error: { message: code, details: 'test-only-sensitive-detail' } }
    const body = await failure(await execute.POST(request(validOperation('boards.list'))), status, code)
    assert.ok(!JSON.stringify(body).includes('test-only-sensitive-detail'))
  }
  for (const error of [{ message: 'test-only-sensitive-database-error' }, { message: 'toString' },
    { message: 'constructor' }, { message: '__proto__' }, { code: '23505', details: 'test-only-sensitive-detail' }]) {
    rpcResult = { data: null, error }
    await failure(await execute.POST(request(validOperation('boards.list'))), 500, 'INTERNAL')
  }
  rpcError = new Error('FORBIDDEN')
  await failure(await execute.POST(request(validOperation('boards.list'))), 403, 'FORBIDDEN')
  rpcError = null
  for (const data of [null, { ok: false, detail: 'test-only-sensitive-detail' }]) {
    rpcResult = { data, error: null }
    await failure(await execute.POST(request(validOperation('boards.list'))), 500, 'INTERNAL')
  }
  rpcResult = { data: { ok: true, data: { items: [] } }, error: null }

  // Connection administration is bound to the signed-in stored executive role.
  for (const actor of [null, { id: actorId, role: 'admin', real_name: '佐藤正彦' },
    { id: actorId, role: 'member', display_name: '佐藤ちさと' }]) {
    currentUser = actor
    const before = rpcCalls.length
    await failure(await admin.GET(adminRequest(null, { method: 'GET' })), actor ? 403 : 401, actor ? 'FORBIDDEN' : 'UNAUTHORIZED')
    await failure(await admin.POST(adminRequest(createBody())), actor ? 403 : 401, actor ? 'FORBIDDEN' : 'UNAUTHORIZED')
    assert.equal(rpcCalls.length, before)
  }
  currentUser = { id: actorId, role: 'executive', status: 'approved' }
  sessionError = new Error('test-only-sensitive-session-error')
  const beforeSessionFailure = rpcCalls.length
  await failure(await admin.GET(adminRequest(null, { method: 'GET' })), 500, 'INTERNAL')
  await failure(await admin.POST(adminRequest(createBody())), 500, 'INTERNAL')
  assert.equal(rpcCalls.length, beforeSessionFailure)
  sessionError = null
  for (const origin of [undefined, 'null', 'https://other.invalid']) {
    const before = rpcCalls.length
    await failure(await admin.POST(adminRequest(createBody(), { headers: origin ? { origin } : {} })), 403, 'FORBIDDEN')
    assert.equal(rpcCalls.length, before)
  }
  const permissions = { action: 'permissions', id: itemId, scopes: [...policy.DATA_OPERATIONS], allowedGroupIds: [], allBoards: true, pcName: 'CEO_S' };
  const changed = await admin.POST(adminRequest(permissions));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).data.token, undefined);
  assert.deepEqual(rpcCalls.at(-1), { name: 'gw_data_connection_admin', args: { p_actor_id: actorId, p_action: 'permissions', p_args: { id: itemId, scopes: [...policy.DATA_OPERATIONS], allowed_group_ids: [], all_boards: true, pc_name: 'CEO_S' } } });
  for (const extra of [{ token_hash: 'a'.repeat(64) }, { expiresAt: new Date(now+86400000).toISOString() }, { principal_user_id: itemId }, { pcName: 'other/host' }, { allBoards: true, allowedGroupIds: [groupId] }, { allBoards: false }]) {
    const count = rpcCalls.length;
    await failure(await admin.POST(adminRequest({ ...permissions, ...extra })), 400, 'VALIDATION');
    assert.equal(rpcCalls.length, count);
  }

  const invalidAdminBodies = [
    { ...createBody(), principal_user_id: itemId }, { ...createBody(), actorId: itemId },
    { ...createBody(), token: 'client-provided-token' }, { ...createBody(), token_hash: 'f'.repeat(64) },
    { ...createBody(), scopes: [] }, { ...createBody(), scopes: ['sql.execute'] },
    { ...createBody(), allowedGroupIds: [] }, { ...createBody(), allowedGroupIds: ['invalid'] },
    { ...createBody(), allowedGroupIds: Array(21).fill(groupId) },
    { ...createBody(), maxLimit: 21 }, { ...createBody(), maxLimit: 0 },
    { ...createBody(), expiresAt: new Date(now).toISOString() },
    { ...createBody(), expiresAt: new Date(now + 90 * 86400000 + 1).toISOString() },
    { action: 'approve_confirmation', id: confirmationId },
    { action: 'approve_confirmation', id: confirmationId, digest: 'invalid' },
    { action: 'approve_confirmation', id: confirmationId, digest: 'f'.repeat(64), principal_user_id: itemId },
    { action: 'revoke', id: 'invalid' }, { action: 'unknown', id: itemId },
  ]
  for (const body of invalidAdminBodies) {
    const before = rpcCalls.length
    await failure(await admin.POST(adminRequest(body)), 400, 'VALIDATION')
    assert.equal(rpcCalls.length, before)
  }
  rpcResult = { data: { ok: true, data: { id: itemId } }, error: null }
  const created = await admin.POST(adminRequest({ ...createBody(),
    scopes: ['boards.list', 'boards.list', 'posts.search'], allowedGroupIds: [groupId, groupId] }))
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const createdBody = await created.json()
  const issuedToken = createdBody.data.token
  assert.match(issuedToken, /^tsg_data_[A-Za-z0-9_-]{43}$/)
  const createCall = rpcCalls.at(-1)
  assert.equal(createCall.name, 'gw_data_connection_admin')
  assert.equal(createCall.args.p_actor_id, actorId)
  assert.equal(createCall.args.p_args.principal_user_id, actorId)
  assert.equal(createCall.args.p_args.token_hash, crypto.createHash('sha256').update(issuedToken).digest('hex'))
  assert.ok(!JSON.stringify(createCall.args).includes(issuedToken))
  assert.deepEqual(createCall.args.p_args.scopes, ['boards.list', 'posts.search'])
  assert.deepEqual(createCall.args.p_args.allowed_group_ids, [groupId])
  assert.equal(createCall.args.p_args.label, '試験接続')
  const boundaryCreateBody = { ...createBody(), expiresAt: new Date(now + 90 * 86400000).toISOString() }
  delete boundaryCreateBody.maxLimit
  const boundaryCreated = await admin.POST(adminRequest(boundaryCreateBody))
  assert.equal(boundaryCreated.status, 201)
  assert.notEqual((await boundaryCreated.json()).data.token, issuedToken, 'Each new connection gets a fresh credential')
  assert.equal(rpcCalls.at(-1).args.p_args.max_limit, 20)

  rpcResult = { data: { ok: true, data: [{ id: itemId, label: '試験接続' }] }, error: null }
  for (const view of ['list', 'list_confirmations', 'list_audit']) {
    const response = await admin.GET(adminRequest(null, { method: 'GET', path: `/api/admin/data-connections?view=${view}` }))
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes(issuedToken) && !text.includes('"token"'), 'Raw tokens are absent from subsequent reads')
    assert.deepEqual(rpcCalls.at(-1).args, { p_actor_id: actorId, p_action: view, p_args: {} })
  }
  const beforeBadView = rpcCalls.length
  await failure(await admin.GET(adminRequest(null, { method: 'GET', path: '/api/admin/data-connections?view=sql' })), 400, 'VALIDATION')
  assert.equal(rpcCalls.length, beforeBadView)
  rpcResult = { data: { ok: true, data: { id: itemId } }, error: null }
  for (const body of [{ action: 'revoke', id: itemId }, { action: 'approve_confirmation', id: confirmationId, digest: 'f'.repeat(64) }]) {
    const response = await admin.POST(adminRequest(body))
    assert.equal(response.status, 200)
    assert.ok(!(await response.text()).includes('"token"'))
    assert.equal(rpcCalls.at(-1).args.p_actor_id, actorId)
    assert.deepEqual(rpcCalls.at(-1).args.p_args, { id: body.id, ...(body.digest ? { digest: body.digest } : {}) })
  }
  rpcResult = { data: null, error: { message: 'FORBIDDEN', details: 'test-only-sensitive-detail' } }
  const rejectedCreate = await failure(await admin.POST(adminRequest(createBody())), 403, 'FORBIDDEN')
  assert.ok(!JSON.stringify(rejectedCreate).includes('"token"'), 'A failed create must not disclose its generated credential')
  assert.ok(!JSON.stringify(warnings).includes('test-only-sensitive'))
  assert.ok(!JSON.stringify(warnings).includes(token))
  assert.ok(!JSON.stringify(warnings).includes(issuedToken))
  console.log('Data API bearer, validation, approval, errors, and connection administration tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  Date.now = originalNow
  console.warn = originalWarn
})
