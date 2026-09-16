const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

let pledgeError = null
let messageError = null
const rpcCalls = []
const pushes = []
const adminClient = {
  async rpc(name) {
    rpcCalls.push(name)
    if (name === 'gw_dispatch_new_hire_company_messages') {
      return messageError ? { data: null, error: messageError } : { data: [{ message_id: 'message-1' }], error: null }
    }
    if (name === 'gw_dispatch_new_hire_pledges') {
      return pledgeError ? { data: null, error: pledgeError } : {
        data: [{ assignment_id: 'assignment-1', user_id: 'user-1', pledge_title: '会社機密情報に関する誓約' }],
        error: null,
      }
    }
    throw new Error(`unexpected RPC ${name}`)
  },
}

function loadRoute() {
  const source = fs.readFileSync('app/api/cron/new-hire-company-messages/route.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mod = { exports: {} }
  const localRequire = (name) => {
    if (name === 'next/server') return { NextResponse: { json: (body, options) => new Response(JSON.stringify(body), { status: options?.status || 200 }) } }
    if (name === '@/lib/supabase/admin') return { adminClient }
    if (name === '@/lib/web-push') return { sendPushNotificationToUser: async (userId, payload) => { pushes.push({ userId, payload }) } }
    return require(name)
  }
  new Function('module', 'exports', 'require', output)(mod, mod.exports, localRequire)
  return mod.exports
}

const route = loadRoute()
const request = (token) => ({ headers: { get: (name) => name === 'authorization' ? token : null } })

async function run() {
  delete process.env.CRON_SECRET
  assert.equal((await route.GET(request(null))).status, 503)

  process.env.CRON_SECRET = 'test-secret'
  assert.equal((await route.GET(request('Bearer wrong'))).status, 401)
  assert.equal(rpcCalls.length, 0)

  const response = await route.GET(request('Bearer test-secret'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true, delivered: 1, pledges: 1, pledgePushFailures: 0 })
  assert.deepEqual(rpcCalls, ['gw_dispatch_new_hire_company_messages', 'gw_dispatch_new_hire_pledges'])
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].userId, 'user-1')
  assert.equal(pushes[0].payload.url, '/groups')
  assert.equal(pushes[0].payload.tag, 'tsg-new-hire-pledge-assignment-1')

  pledgeError = { message: 'pledge failed' }
  const pushesBeforePledgeFailure = pushes.length
  assert.equal((await route.GET(request('Bearer test-secret'))).status, 500)
  assert.equal(pushes.length, pushesBeforePledgeFailure)
  pledgeError = null
  messageError = { message: 'message failed' }
  const pushesBeforeMessageFailure = pushes.length
  assert.equal((await route.GET(request('Bearer test-secret'))).status, 500)
  assert.equal(pushes.length, pushesBeforeMessageFailure + 1)

  console.log('New-hire automation cron: auth, both dispatches, pledge push and failures passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
