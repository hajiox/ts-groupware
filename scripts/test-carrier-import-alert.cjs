const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file, dependencies = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => dependencies[name] || require(name))
  return loaded.exports
}
const logic = load('lib/carrier-import-alert.ts')
const valid = { sourceKey: 'carrier-import:2026-08:yamato-sagawa:needs_operator:v1', period: '2026-08', carriers: ['sagawa', 'yamato'], reason: 'browser_access', status: 'needs_operator' }
const result = logic.carrierImportAlert(valid)
assert.match(result.content, /2026-08 ヤマト・佐川/)
assert.match(result.content, /未起動が原因とは限りません/)
assert.match(result.content, /http:\/\/192\.168\.110\.200:3003\/\?carrierImport=2026-08#carrier-import/)
assert.match(result.content, /リンクを開くだけでは実行されません/)
assert.equal(result.content, logic.carrierImportAlert({ ...valid, carriers: ['yamato', 'sagawa'] }).content)
for (const patch of [{ period: '2026-13' }, { carriers: [] }, { carriers: ['yamato', 'yamato'] }, { carriers: ['other'] }, { sourceKey: 'x/y' }, { status: 'ok' }, { reason: 'constructor' }, { content: 'injection' }, { url: 'https://evil.example' }]) assert.throws(() => logic.carrierImportAlert({ ...valid, ...patch }), /is invalid/)
assert.match(logic.carrierImportAlert({ ...valid, status: 'recovered' }).content, /復旧/)
assert.equal(logic.carrierImportAlertPostId(valid.sourceKey), logic.carrierImportAlertPostId(valid.sourceKey))
assert.notEqual(logic.carrierImportAlertPostId(valid.sourceKey), logic.carrierImportAlertPostId(valid.sourceKey + ':v2'))

let stored = null, pushes = 0, calls = 0, race = false
const adminClient = { from(table) {
  calls++
  let operation = 'read', row
  const query = {
    select() { return query }, eq() { return query },
    insert(value) { operation = 'insert'; row = value; return query },
    update() { operation = 'update'; return query },
    maybeSingle() { return Promise.resolve({ data: stored, error: null }) },
    single() {
      if (operation === 'insert') {
        stored = { ...row, created_at: '2026-09-07T00:00:00Z' }
        if (race) return Promise.resolve({ data: null, error: { code: '23505' } })
      }
      return Promise.resolve({ data: stored, error: null })
    },
    then(resolve, reject) { return Promise.resolve({ data: table === 'gw_groups' ? [{ id: 'management', name: 'TS（管理職）', type: 'board' }] : null, error: null }).then(resolve, reject) },
  }
  return query
} }
const route = load('app/api/integrations/tsa/carrier-import-alert/route.ts', {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
  '@/lib/supabase/admin': { adminClient }, '@/lib/tsg-ai': { getTsgUserId: async () => 'tsg-bot' },
  '@/lib/meeting-transcriber-summary': load('lib/meeting-transcriber-summary.ts'),
  '@/lib/carrier-import-alert': logic,
  '@/lib/web-push': { sendPushNotificationToGroup: async () => { pushes++ } },
})
function request(body, authorized = true) { return new Request('http://localhost/api/integrations/tsa/carrier-import-alert', { method: 'POST', headers: authorized ? { 'x-tsg-integration-secret': 'test-only-secret' } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) }) }
async function main() {
  process.env.TSG_INTEGRATION_SECRET = 'test-only-secret'
  assert.equal((await route.POST(request(valid, false))).status, 401)
  assert.equal(calls, 0)
  assert.equal((await route.GET(request(valid))).status, 200)
  assert.equal(stored, null)
  assert.equal((await route.POST(request('{'))).status, 400)
  assert.equal((await route.POST(request('x'.repeat(4097)))).status, 413)
  const first = await route.POST(request(valid))
  assert.equal(first.status, 201); assert.equal(first.body.duplicate, false); assert.equal(pushes, 1)
  assert.equal(first.body.group.name, 'TS（管理職）'); assert.equal(first.body.poster.displayName, 'TSG君')
  const duplicate = await route.POST(request(valid))
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true); assert.equal(pushes, 1)
  assert.equal((await route.POST(request({ ...valid, status: 'recovered' }))).status, 409)
  assert.equal(pushes, 1)
  stored = null; race = true
  const concurrent = await route.POST(request(valid))
  assert.equal(concurrent.status, 200); assert.equal(concurrent.body.duplicate, true); assert.equal(pushes, 1)
  console.log('Carrier import alert input, authorization, readiness, posting, duplicate/conflict and race tests passed (mock storage; no live posts).')
}
main().catch(error => { console.error(error); process.exitCode = 1 })

