const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

function load(file, deps = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => deps[name] || require(name))
  return loaded.exports
}
class JsonResponse extends Response {
  static json(body, init) { return new JsonResponse(JSON.stringify(body), init) }
}
const next = { NextResponse: JsonResponse }
const http = load('lib/data-api-http.ts', { 'next/server': next })
const policy = load('lib/codex-mtg-policy.ts')
const core = load('lib/codex-mtg.ts', { 'next/server': next, '@/lib/data-api-http': http, '@/lib/codex-mtg-policy': policy })
const roles = load('lib/user-roles.ts')
const calls = []
const pushCalls = []
const dmPushCalls = []
const dmReads = []
const jobReads = []
const postReads = []
const notificationContent = `【PC: TSA】\n${'保存済みの報告本文'.repeat(12)}`
let pushShouldFail = false
let dmPushShouldFail = false
let completionJob = null
let actor = null
let rpcResult = { data: { ok: true, data: { job: null } }, error: null }
const deps = {
  '@/lib/codex-mtg': core,
  '@/lib/data-api-http': http,
  '@/lib/user-roles': roles,
  '@/lib/session': { getUserSession: async () => actor },
  '@/lib/web-push': { sendPushNotificationToGroup: async (...args) => {
    pushCalls.push(args)
    if (pushShouldFail) throw new Error('Synthetic push failure')
  }, sendPushNotificationToUser: async (...args) => {
    dmPushCalls.push(args)
    if (dmPushShouldFail) throw new Error('Synthetic DM push failure')
  } },
  '@/lib/supabase/admin': { adminClient: {
    rpc: async (name, args) => { calls.push({ name, args }); return rpcResult },
    from(table) {
      assert.ok(['gw_posts', 'gw_codex_mtg_jobs'].includes(table))
      const filters = {}
      const query = {
        select(columns) { assert.ok(['id,content', 'author_id,result_dm_post_id', 'id,group_id,content'].includes(columns)); return query },
        eq(key, value) { filters[key] = value; return query },
        async maybeSingle() {
          if (table === 'gw_codex_mtg_jobs') {
            jobReads.push({ ...filters })
            return { data: completionJob, error: null }
          }
          if (!filters.group_id) {
            dmReads.push({ ...filters })
            return { data: { id: filters.id, group_id: uuid, content: notificationContent }, error: null }
          }
          postReads.push({ ...filters })
          return { data: { id: filters.id, content: notificationContent }, error: null }
        },
      }
      return query
    },
  } },
}
const machine = load('app/api/integrations/codex-mtg/route.ts', deps)
const admin = load('app/api/admin/codex-mtg/route.ts', deps)
const token = `tsg_mtg_${'a'.repeat(43)}`
const base = 'https://tsg-test.invalid'
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function request(body, { method = 'POST', headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, suffix = '', raw } = {}) {
  const url = new URL(`/api/integrations/codex-mtg${suffix}`, base)
  const r = new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: raw === undefined ? JSON.stringify(body) : raw }) })
  r.nextUrl = url
  return r
}
function adminRequest(body, options = {}) {
  return request(body, { headers: { origin: base, 'content-type': 'application/json' }, ...options })
}
async function failure(response, status, code) {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, code)
  assert.equal(JSON.stringify(body).includes(token), false)
  assert.equal(response.headers.get('cache-control'), 'no-store')
}
async function main() {
  for (const headers of [{}, { cookie: `gw_user_session=${uuid}` },
    { authorization: `Bearer tsg_data_${'a'.repeat(43)}` },
    { 'x-tsg-integration-secret': 'not-a-machine-credential' },
    { authorization: `Bearer ${token} extra` }, { authorization: `Basic ${token}` }]) {
    const before = calls.length
    const r = request({ action: 'claim' }, { headers })
    await failure(await machine.POST(r), 401, 'UNAUTHORIZED')
    assert.equal(r.bodyUsed, false)
    await failure(await machine.GET(request(null, { method: 'GET', headers })), 401, 'UNAUTHORIZED')
    assert.equal(calls.length, before)
  }
  for (const body of [
    { action: 'post', sourceKey: 'key', content: 'x', kind: 'report', pcName: 'TSA' },
    { action: 'post', sourceKey: 'key', content: 'x', kind: 'report', boardId: uuid },
    { action: 'post', sourceKey: 'job-complete:fake', content: 'x', kind: 'report' },
    { action: 'post', sourceKey: 'key', content: 'x', kind: 'execute' },
    { action: 'claim', canExecuteCode: true },
    { action: 'complete', jobId: uuid, leaseToken: uuid, status: 'pending', summary: 'x' },
  ]) {
    const before = calls.length
    await failure(await machine.POST(request(body)), 400, 'VALIDATION')
    assert.equal(calls.length, before)
  }
  for (const raw of ['{', JSON.stringify({ action: 'claim', padding: 'x'.repeat(33000) })]) {
    await failure(await machine.POST(request(null, { raw })), 400, 'VALIDATION')
  }
  await failure(await machine.GET(request(null, { method: 'GET', suffix: '?pcName=TSA' })), 400, 'VALIDATION')
  const response = await machine.POST(request({ action: 'claim' }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).job, null)
  const call = calls.at(-1)
  assert.equal(call.name, 'gw_codex_mtg_machine')
  assert.equal(call.args.p_token_hash, crypto.createHash('sha256').update(token).digest('hex'))
  assert.deepEqual(call.args.p_args, {})
  assert.equal(JSON.stringify(calls).includes(token), false)
  rpcResult = { data: { ok: false, code: 'UNAUTHORIZED' }, error: null }
  await failure(await machine.GET(request(null, { method: 'GET' })), 401, 'UNAUTHORIZED')
  const originalWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    for (const body of [
      { action: 'post', sourceKey: 'notification:new-post', content: '本文', kind: 'report' },
      { action: 'complete', jobId: uuid, leaseToken: uuid, status: 'completed', summary: '完了した内容' },
    ]) {
      for (const scenario of ['new', 'duplicate', 'pushFailure']) {
        const duplicate = scenario === 'duplicate'
        pushShouldFail = scenario === 'pushFailure'
        rpcResult = { data: { ok: true, data: { postId: uuid, duplicate,
          ...(body.action === 'complete' ? { jobId: uuid, status: 'completed' } : {}) } }, error: null }
        const beforePush = pushCalls.length
        const beforeRead = postReads.length
        const result = await machine.POST(request(body))
        assert.equal(result.status, 200, `${body.action}: ${scenario} preserves the committed response`)
        const saved = await result.json()
        assert.equal(saved.ok, true)
        assert.equal(saved.postId, uuid)
        assert.equal(saved.duplicate, duplicate)
        if (body.action === 'complete') assert.equal(saved.status, 'completed')
        assert.equal(pushCalls.length - beforePush, duplicate ? 0 : 1,
          `${body.action}: only the first creation attempts one notification`)
        assert.equal(postReads.length - beforeRead, duplicate ? 0 : 1,
          'Duplicate delivery must not read or notify the post again')
        if (!duplicate) {
          assert.deepEqual(postReads.at(-1), { id: uuid, group_id: policy.CODEX_MTG_GROUP_ID, user_id: policy.CODEX_MTG_BOT_USER_ID })
          assert.deepEqual(pushCalls.at(-1), [policy.CODEX_MTG_GROUP_ID, policy.CODEX_MTG_BOT_USER_ID, {
            title: 'CodexMTG - TSG君', body: notificationContent.substring(0, 80),
            url: `/chat/${policy.CODEX_MTG_GROUP_ID}`, tag: `codex-mtg-${uuid}`,
          }, uuid])
        }
      }
    }
  } finally {
    console.warn = originalWarn
    pushShouldFail = false
  }
  assert.equal(warnings.length, 2, 'Each failed push is recorded without changing save success')
  for (const warning of warnings) {
    assert.equal(warning[0], '[codex-mtg] Push notification could not be delivered')
    assert.deepEqual(Object.keys(warning[1]), ['requestId'])
    assert.equal(JSON.stringify(warning).includes(token), false)
    assert.equal(JSON.stringify(warning).includes(notificationContent), false)
  }
  completionJob = { author_id: uuid, result_dm_post_id: uuid }
  for (const scenario of ['new', 'duplicate', 'groupPushFailure', 'dmPushFailure', 'codex', 'needs_operator', 'failed']) {
    const duplicate = scenario === 'duplicate'
    const status = ['needs_operator', 'failed'].includes(scenario) ? scenario : 'completed'
    completionJob = scenario === 'codex' ? null : { author_id: uuid, result_dm_post_id: uuid }
    pushShouldFail = scenario === 'groupPushFailure'
    dmPushShouldFail = scenario === 'dmPushFailure'
    rpcResult = { data: { ok: true, data: { postId: uuid, duplicate, jobId: uuid, status } }, error: null }
    const before = dmPushCalls.length
    const beforeJobs = jobReads.length
    console.warn = () => {}
    try {
      const result = await machine.POST(request({ action: 'complete', jobId: uuid, leaseToken: uuid, status, summary: '結果' }))
      assert.equal(result.status, 200, 'Optional push failure cannot undo saved results')
    } finally { console.warn = originalWarn }
    const shouldPush = !duplicate && status === 'completed' && scenario !== 'codex'
    assert.equal(dmPushCalls.length - before, shouldPush ? 1 : 0, scenario)
    assert.equal(jobReads.length - beforeJobs, !duplicate && status === 'completed' ? 1 : 0)
    if (shouldPush) {
      assert.deepEqual(jobReads.at(-1), { id: uuid, result_post_id: uuid, origin: 'human', status: 'completed' })
      assert.deepEqual(dmReads.at(-1), { id: uuid, user_id: policy.CODEX_MTG_BOT_USER_ID })
      assert.deepEqual(dmPushCalls.at(-1), [uuid, {
        title: '開発依頼の結果 - TSG君', body: notificationContent.substring(0, 80),
        url: `/chat/${uuid}`, tag: `codex-mtg-dm-${uuid}`,
      }, uuid])
    }
  }
  pushShouldFail = false
  dmPushShouldFail = false
  completionJob = null
  rpcResult = { data: { ok: true, data: {} }, error: null }
  for (const user of [null, { id: uuid, role: 'member', status: 'approved' }, { id: uuid, role: 'executive', status: 'suspended' }]) {
    actor = user
    const before = calls.length
    await failure(await admin.GET(), user ? 403 : 401, user ? 'FORBIDDEN' : 'UNAUTHORIZED')
    await failure(await admin.POST(adminRequest({ action: 'register', pcName: 'TSA' })), user ? 403 : 401, user ? 'FORBIDDEN' : 'UNAUTHORIZED')
    assert.equal(calls.length, before)
  }
  actor = { id: uuid, role: 'admin', status: 'approved' }
  assert.equal((await admin.GET()).status, 200)
  await failure(await admin.POST(adminRequest({ action: 'register', pcName: 'TSA' })), 403, 'FORBIDDEN')
  actor = { id: uuid, role: 'executive', status: 'approved' }
  await failure(await admin.POST(adminRequest({ action: 'register', pcName: 'TSA' }, { headers: { origin: 'https://evil.invalid' } })), 403, 'FORBIDDEN')
  await failure(await admin.POST(adminRequest({ action: 'register', pcName: 'OTHER', canExecuteCode: true })), 400, 'VALIDATION')
  const registered = await admin.POST(adminRequest({ action: 'register', pcName: 'OTHER' }))
  assert.equal(registered.status, 201)
  const data = await registered.json()
  assert.match(data.token, /^tsg_mtg_[A-Za-z0-9_-]{43}$/)
  assert.equal(calls.at(-1).args.p_args.tokenHash, crypto.createHash('sha256').update(data.token).digest('hex'))
  assert.equal(JSON.stringify(calls).includes(data.token), false)
  assert.equal(calls.at(-1).args.p_args.canExecuteCode, undefined)
  rpcResult = { data: { ok: true, data: { job: null } }, error: null }
  assert.equal((await machine.POST(request({ action: 'peerClaim' }))).status, 200)
  assert.equal(calls.at(-1).name, 'gw_codex_mtg_peer')
  await failure(await machine.POST(request({ action: 'peerClaim', machineId: uuid })), 400, 'VALIDATION')
  await failure(await machine.POST(request({ action: 'peerComplete', jobId: uuid, leaseToken: uuid, decision: 'execute', summary: 'invalid' })), 400, 'VALIDATION')
  for (const decision of ['silent', 'report', 'question', 'needs_operator']) {
    const before = pushCalls.length
    rpcResult = { data: { ok: true, data: { jobId: uuid, decision, postId: decision === 'silent' ? null : uuid, duplicate: false } }, error: null }
    assert.equal((await machine.POST(request({ action: 'peerComplete', jobId: uuid, leaseToken: uuid, decision, summary: decision === 'silent' ? '' : '回答' }))).status, 200)
    assert.equal(calls.at(-1).name, 'gw_codex_mtg_peer')
    assert.equal(pushCalls.length - before, decision === 'silent' ? 0 : 1)
  }
  console.log('CodexMTG HTTP boundary, peer routing and notification checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
