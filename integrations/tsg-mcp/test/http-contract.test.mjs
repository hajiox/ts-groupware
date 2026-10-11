import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { TOOLS, toApiRequest } from '../src/tools.mjs'

const policyPath = fileURLToPath(new URL('../../../lib/data-api-policy.ts', import.meta.url))
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const metaKeys = new Set(['idempotencyKey', 'expectedVersion', 'confirmationId'])

// The adapter remains portable. In the application checkout, also test against
// the actual HTTP policy with its own Zod version instead of a copied contract.
test('legacy and business tools match the actual application HTTP policies', (context) => {
  if (!fs.existsSync(policyPath)) {
    context.skip('Application policy is unavailable in this standalone distribution')
    return
  }
  const appRequire = createRequire(policyPath)
  const ts = appRequire('typescript')
  const compiled = ts.transpileModule(fs.readFileSync(policyPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, appRequire)
  const { DATA_OPERATIONS, BUSINESS_OPERATIONS, dataExecuteSchema, businessExecuteSchema } = loaded.exports
  assert.deepEqual(new Set(TOOLS.map((tool) => tool.operation)), new Set([...DATA_OPERATIONS, ...BUSINESS_OPERATIONS]))
  const schemaFor = tool => tool.operation.startsWith('business.') ? businessExecuteSchema : dataExecuteSchema

  function envelope(tool, args) {
    return {
      operation: tool.operation,
      input: Object.fromEntries(Object.entries(args).filter(([key]) => !metaKeys.has(key))),
      ...Object.fromEntries(Object.entries(args).filter(([key]) => metaKeys.has(key))),
    }
  }
  function agrees(tool, args) {
    assert.equal(tool.schema.safeParse(args).success, schemaFor(tool).safeParse(envelope(tool, args)).success, tool.name)
  }
  for (const tool of TOOLS) {
    if (tool.operation.startsWith('business.')) continue
    const args = {}
    for (const key of tool.inputKeys) {
      args[key] = key === 'id' || key === 'group_id' ? uuid : key === 'limit' ? 20 : key === 'offset' ? 10000 : key === 'content' ? '正常な本文' : '検索語'
    }
    if (!tool.readOnly) args.idempotencyKey = 'contract_test_01'
    if (['drafts.update', 'tasks.complete', 'posts.publish.prepare', 'posts.publish.commit'].includes(tool.operation)) args.expectedVersion = '1'
    if (tool.operation === 'posts.publish.commit') args.confirmationId = uuid
    assert.equal(dataExecuteSchema.safeParse(toApiRequest(tool, args)).success, true, tool.operation)
    agrees(tool, args)
    agrees(tool, { ...args, sql: 'select 1' })
    agrees(tool, { ...args, token: 'not-an-argument' })
    agrees(tool, { ...args, table: 'gw_users' })
    agrees(tool, { ...args, pcName: 'TSA' })
    if ('id' in args) agrees(tool, { ...args, id: 'invalid' })
    if ('group_id' in args) agrees(tool, { ...args, group_id: 'invalid' })
    if ('query' in args) {
      agrees(tool, { ...args, query: 'a'.repeat(257) })
      agrees(tool, { ...args, query: 'bad\0query' })
    }
    if ('limit' in args) for (const limit of [0, 21, 1.5, '20']) agrees(tool, { ...args, limit })
    if ('offset' in args) {
      for (const offset of [-1, 10001, 1.5, '20', null]) agrees(tool, { ...args, offset })
      for (const offset of [0, 20, 10000]) {
        const paged = { ...args, offset }
        assert.equal(tool.schema.safeParse(paged).success, true, tool.name)
        agrees(tool, paged)
      }
      const noOffset = { ...args }; delete noOffset.offset
      agrees(tool, noOffset)
    }
    if ('content' in args) for (const content of ['', ' \n ', 'a'.repeat(4001), 'bad\0content']) agrees(tool, { ...args, content })
    if (!tool.readOnly) {
      const noKey = { ...args }; delete noKey.idempotencyKey
      agrees(tool, noKey)
      agrees(tool, { ...args, idempotencyKey: 'invalid.key' })
    }
    if ('expectedVersion' in args) {
      const noVersion = { ...args }; delete noVersion.expectedVersion
      agrees(tool, noVersion)
      agrees(tool, { ...args, expectedVersion: ' ' })
    }
    if ('confirmationId' in args) {
      const noConfirmation = { ...args }; delete noConfirmation.confirmationId
      agrees(tool, noConfirmation)
    }
  }
  const draftsList = TOOLS.find((tool) => tool.operation === 'drafts.list')
  agrees(draftsList, { query: 'unsupported' })
  for (const [name, args] of [
    ['business_operations_list', {}], ['business_operations_list', { area: 'payroll' }],
    ['business_read', { operationId: 'payroll.diff', query: { payrollMonth: '2026-09' } }],
    ['business_write', { operationId: 'files.upload', files: [{ field: 'file', name: 'test.txt', type: 'text/plain', base64: 'YQ==' }], idempotencyKey: 'upload_test_01' }],
  ]) {
    const tool = TOOLS.find(tool => tool.name === name)
    assert.equal(schemaFor(tool).safeParse(toApiRequest(tool, args)).success, true)
    agrees(tool, args)
    agrees(tool, { ...args, endpoint: 'https://example.invalid' })
    agrees(tool, { ...args, pcName: 'other' })
  }
})
