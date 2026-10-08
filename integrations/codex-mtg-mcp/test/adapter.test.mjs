import test from 'node:test'
import assert from 'node:assert/strict'
import { execute, createServer } from '../src/server.mjs'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

const config = { token: `tsg_mtg_${'a'.repeat(43)}`, pcName: 'CEO_S' }
const snapshot = { ok: true, machine: { pcName: 'CEO_S', canExecuteCode: false }, group: { id: 'a8081dbe-15db-4d41-a18b-b22bb55d2b39' }, posts: [], realtime: { anonKey: 'excluded' } }
const response = value => new Response(JSON.stringify(value), { status: 200 })
test('fixed endpoint, identity and no realtime credentials in read result', async () => {
  const result = await execute(config, 'codex_mtg_read', {}, async (url, init) => {
    assert.equal(url, 'https://v0-line-blush.vercel.app/api/integrations/codex-mtg')
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, `Bearer ${config.token}`)
    return response(snapshot)
  })
  assert.equal(result.ok, true); assert.equal(result.realtime, undefined)
})
test('foreign PC identity cannot read or post', async () => {
  let calls = 0
  const result = await execute({ ...config, pcName: 'CEO-DOUGA' }, 'codex_mtg_report', { sourceKey: 'report:one', content: 'authorized' }, async () => { calls++; return response(snapshot) })
  assert.equal(result.code, 'PC_IDENTITY_MISMATCH'); assert.equal(calls, 1)
})
test('only three tools; invalid input never reaches API', async () => {
  for (const [name, args] of [['claim', {}], ['codex_mtg_report', { sourceKey: 'job-complete:one', content: 'x' }], ['codex_mtg_read', { token: 'bad' }], ['codex_mtg_report', { sourceKey: 'one', content: 'x', pcName: 'TSA' }]]) {
    const result = await execute(config, name, args, () => { throw Error('Must not fetch') })
    assert.match(result.code, /TOOL_NOT_ALLOWED|INVALID_ARGUMENTS/)
  }
})
test('report/request preserve idempotency identity and never claim jobs', async () => {
  for (const kind of ['report', 'request']) {
    let calls = 0
    const result = await execute(config, `codex_mtg_${kind}`, { sourceKey: 'question:one:v1', content: '質問です' }, async (_url, init) => {
      if (++calls === 1) return response(snapshot)
      assert.deepEqual(JSON.parse(init.body), { action: 'post', sourceKey: 'question:one:v1', content: '質問です', kind })
      return response({ ok: true, postId: '123', duplicate: true })
    })
    assert.equal(result.duplicate, true); assert.equal(calls, 2)
  }
})
test('uncertain write not automatically retried, exception and reflected key are redacted', async () => {
  let calls = 0
  const result = await execute(config, 'codex_mtg_report', { sourceKey: 'one', content: 'x' }, async () => { if (++calls === 1) return response(snapshot); throw Error(config.token) })
  assert.equal(calls, 2); assert.equal(result.code, 'DELIVERY_UNKNOWN_READ_BEFORE_RETRY')
  const read = await execute(config, 'codex_mtg_read', {}, async () => response({ ...snapshot, posts: [{ content: config.token }] }))
  assert.ok(!JSON.stringify(read).includes(config.token))
})
test('SDK handshake and raw tools/list contain exactly three tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer(config, async () => response(snapshot))
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(serverTransport); await client.connect(clientTransport)
  try { assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['codex_mtg_read', 'codex_mtg_report', 'codex_mtg_request']); assert.equal((await client.callTool({ name: 'codex_mtg_read', arguments: {} })).isError, false) }
  finally { await client.close(); await server.close() }
})
