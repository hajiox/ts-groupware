import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { execute, loadConfig, PRODUCTION_ORIGIN, redact } from '../src/api.mjs'
import { TOOLS, TOOLS_BY_NAME } from '../src/tools.mjs'

const folder = fileURLToPath(new URL('..', import.meta.url))
const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url))
const preload = fileURLToPath(new URL('./mock-https.mjs', import.meta.url))
const token = `tsg_data_${'x'.repeat(43)}` // Synthetic test value only.
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const confirmation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function resultBody(result) {
  return result.structuredContent || JSON.parse(result.content.find((item) => item.type === 'text').text)
}

test('configuration pins the production origin and never prints credentials', () => {
  assert.equal(loadConfig({ TSG_DATA_API_TOKEN: token }).endpoint, `${PRODUCTION_ORIGIN}/api/data/v1/execute`)
  for (const length of [40, 128]) assert.equal(loadConfig({ TSG_DATA_API_TOKEN: `tsg_data_${'x'.repeat(length)}` }).token.length, length + 9)
  for (const length of [39, 129]) assert.throws(() => loadConfig({ TSG_DATA_API_TOKEN: `tsg_data_${'x'.repeat(length)}` }), /TSG_CONFIG_TOKEN_INVALID/)
  for (const base of ['http://v0-line-blush.vercel.app', 'https://other.invalid', 'http://localhost:3000', `${PRODUCTION_ORIGIN}/api/data`, `${PRODUCTION_ORIGIN}?token=${token}`, `https://${token}@v0-line-blush.vercel.app`]) {
    assert.throws(() => loadConfig({ TSG_DATA_API_TOKEN: token, TSG_DATA_API_BASE_URL: base }), /TSG_CONFIG_ORIGIN_INVALID/)
  }
  assert.throws(() => loadConfig({ TSG_DATA_API_TOKEN: '' }), /TSG_CONFIG_TOKEN_INVALID/)
  const failed = spawnSync(process.execPath, [serverPath], { cwd: folder, encoding: 'utf8', env: { ...process.env, TSG_DATA_API_TOKEN: token, TSG_DATA_API_BASE_URL: `https://${token}@other.invalid` }, timeout: 5000 })
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, '')
  assert.match(failed.stderr, /TSG MCP startup failed/)
  assert.ok(!failed.stderr.includes(token))
})

test('fixed tool schemas reject unknown fields and unsafe writes', () => {
  assert.equal(TOOLS.length, 14)
  assert.equal(TOOLS_BY_NAME.has('sql_execute'), false)
  assert.equal(TOOLS_BY_NAME.get('posts_search').schema.safeParse({ query: 'a'.repeat(257) }).success, false)
  assert.equal(TOOLS_BY_NAME.get('posts_search').schema.safeParse({ query: 'bad\0query' }).success, false)
  assert.equal(TOOLS_BY_NAME.get('drafts_list').schema.safeParse({ query: 'unsupported' }).success, false)
  for (const name of ['boards_list', 'posts_search', 'knowledge_search', 'drafts_list', 'tasks_search']) {
    for (const offset of [0, 20, 10000]) assert.equal(TOOLS_BY_NAME.get(name).schema.safeParse({ offset }).success, true, name)
    for (const offset of [-1, 10001, 1.5, '20', null]) assert.equal(TOOLS_BY_NAME.get(name).schema.safeParse({ offset }).success, false, name)
  }
  for (const content of ['', ' \n ', 'a'.repeat(4001), 'bad\0text']) {
    assert.equal(TOOLS_BY_NAME.get('drafts_create').schema.safeParse({ group_id: id, content, idempotencyKey: 'test_create_01' }).success, false)
  }
  for (const args of [
    { id, expectedVersion: '1' },
    { id, idempotencyKey: 'test_update_01' },
    { id, expectedVersion: '1', idempotencyKey: 'contains.dot' },
    { id, expectedVersion: ' ', idempotencyKey: 'test_update_01' },
  ]) assert.equal(TOOLS_BY_NAME.get('tasks_complete').schema.safeParse(args).success, false)
  assert.equal(TOOLS_BY_NAME.get('post_publish_commit').schema.safeParse({ id, expectedVersion: '1', idempotencyKey: 'test_publish_01' }).success, false)
})

test('secret redaction includes nested values and object keys', () => {
  const output = JSON.stringify(redact({ [token]: token, nested: { authorization: 'Bearer synthetic', token_hash: 'opaque', content: token } }, token))
  assert.ok(!output.includes(token))
  assert.ok(!output.includes('Bearer synthetic'))
  assert.ok(!output.includes('opaque'))
})

test('actual spawned STDIO MCP initializes, lists fixed tools, and calls mocked HTTPS', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', pathToFileURL(preload).href, serverPath], cwd: folder,
    env: { ...process.env, TSG_DATA_API_TOKEN: token, TSG_DATA_API_BASE_URL: PRODUCTION_ORIGIN }, stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  const client = new Client({ name: 'tsg-adapter-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    assert.equal(client.getServerVersion().version, '1.1.0')
    const listed = await client.listTools()
    assert.equal(listed.tools.length, 14)
    assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), new Set(TOOLS.map((tool) => tool.name)))
    for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false)
    const first = resultBody(await client.callTool({ name: 'boards_list', arguments: { limit: 2, offset: 20 } }))
    assert.deepEqual(first.data.request, { operation: 'boards.list', input: { limit: 2, offset: 20 } })
    assert.equal(first.data.nextOffset, 22)

    for (const call of [
      { name: 'sql_execute', arguments: { sql: 'select 1' } },
      { name: token, arguments: {} },
      { name: 'posts_search', arguments: { table: 'gw_users', limit: 1 } },
      { name: 'posts_search', arguments: { limit: 21 } },
      { name: 'boards_list', arguments: { offset: -1 } },
      { name: 'posts_search', arguments: { offset: 10001 } },
      { name: 'knowledge_search', arguments: { offset: 0.5 } },
      { name: 'drafts_list', arguments: { offset: '20' } },
      { name: 'tasks_search', arguments: { offset: null } },
      { name: 'posts_search', arguments: { token } },
      { name: 'drafts_create', arguments: { group_id: id, content: 'No identity override', idempotencyKey: 'test_identity_01', pcName: 'TSA' } },
      { name: 'drafts_create', arguments: { group_id: id, content: 'Draft only' } },
      { name: 'post_publish_commit', arguments: { id, expectedVersion: '1', idempotencyKey: 'test_publish_01' } },
      { name: 'posts_search', arguments: { query: token } },
    ]) {
      const result = await client.callTool(call)
      assert.equal(result.isError, true)
      assert.ok(!JSON.stringify(result).includes(token))
    }
    const afterRefusals = resultBody(await client.callTool({ name: 'boards_list', arguments: {} }))
    assert.equal(afterRefusals.data.callCount, first.data.callCount + 1, 'Rejected inputs never reach HTTPS')

    const cases = [
      ['posts_search', { group_id: id, query: 'Japanese 日本語', limit: 3, offset: 40 }, 'posts.search'],
      ['posts_get', { id }, 'posts.get'],
      ['knowledge_search', { query: 'manual', offset: 10000 }, 'knowledge.search'],
      ['knowledge_get', { id }, 'knowledge.get'],
      ['drafts_create', { group_id: id, content: '日本語の下書き\n二行目', idempotencyKey: 'test_create_01' }, 'drafts.create'],
      ['drafts_update', { id, content: 'Updated draft', idempotencyKey: 'test_update_01', expectedVersion: '1' }, 'drafts.update'],
      ['drafts_get', { id }, 'drafts.get'],
      ['drafts_list', { group_id: id, limit: 5, offset: 15 }, 'drafts.list'],
      ['tasks_search', { query: 'assigned', limit: 10, offset: 90 }, 'tasks.search'],
      ['tasks_get', { id }, 'tasks.get'],
      ['tasks_complete', { id, idempotencyKey: 'test_complete_01', expectedVersion: '2026-10-07T01:00:00.123456Z' }, 'tasks.complete'],
      ['post_publish_prepare', { id, idempotencyKey: 'test_prepare_01', expectedVersion: '2' }, 'posts.publish.prepare'],
      ['post_publish_commit', { id, idempotencyKey: 'test_commit_01', expectedVersion: '2', confirmationId: confirmation }, 'posts.publish.commit'],
    ]
    for (const [name, args, operation] of cases) {
      const result = resultBody(await client.callTool({ name, arguments: args }))
      assert.equal(result.ok, true)
      assert.equal(result.data.request.operation, operation)
      if (args.offset !== undefined) {
        assert.equal(result.data.request.input.offset, args.offset)
        assert.equal(result.data.nextOffset, args.offset === 10000 ? null : args.offset + (args.limit ?? 10))
      }
      for (const field of ['idempotencyKey', 'expectedVersion', 'confirmationId']) {
        assert.equal(result.data.request[field], args[field])
        assert.equal(Object.hasOwn(result.data.request.input, field), false)
      }
    }
    const replayArgs = { group_id: id, content: 'same draft', idempotencyKey: 'test_replay_01' }
    const replayA = resultBody(await client.callTool({ name: 'drafts_create', arguments: replayArgs }))
    const replayB = resultBody(await client.callTool({ name: 'drafts_create', arguments: replayArgs }))
    assert.deepEqual(replayA.data.request, replayB.data.request, 'Adapter preserves caller idempotency keys unchanged')

    for (const query of ['redact-test', 'network-failure', 'non-json', 'oversized', 'denied']) {
      const result = await client.callTool({ name: 'posts_search', arguments: { query } })
      assert.ok(!JSON.stringify(result).includes(token))
      if (query !== 'redact-test') assert.equal(result.isError, true)
    }
    assert.equal(stderr, '')
  } finally {
    await client.close()
    await transport.close()
  }
}, { timeout: 15000 })

test('no retry or credential-bearing exception detail escapes a failed request', async () => {
  let calls = 0
  const result = await execute(loadConfig({ TSG_DATA_API_TOKEN: token }), { operation: 'boards.list', input: {} }, async () => {
    calls += 1
    throw new Error(`Authorization: Bearer ${token}`)
  })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes(token))
})
