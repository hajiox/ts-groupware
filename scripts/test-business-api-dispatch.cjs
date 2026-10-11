const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')
const { NextRequest } = require('next/server')

const root = path.resolve(__dirname, '..')
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const MAX_BINARY = 2 * 1024 * 1024
const MAX_JSON = 3 * 1024 * 1024
const validId = '11111111-1111-4111-8111-111111111111'

function transpile(relative, requireMock) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const commonjsModule = { exports: {} }
  const context = {
    Buffer, Headers, Request, Response, URL, FormData, File, Uint8Array, console,
    require: requireMock, module: commonjsModule, exports: commonjsModule.exports,
  }
  vm.runInNewContext(compiled, context, { filename: relative })
  return commonjsModule.exports
}

const catalog = transpile('lib/business-api/catalog.ts', () => { throw new Error('Catalog imported an unexpected dependency') })

function fixture(responder = () => Response.json({ ok: true })) {
  const calls = []
  const imports = []
  const dispatch = transpile('lib/business-api/dispatch.ts', id => {
    if (id === 'next/server') return { NextRequest }
    if (id === './catalog') return catalog
    assert.match(id, /^@\/app\/api\/.+\/route$/)
    imports.push(id)
    return Object.fromEntries(methods.map(method => [method, async (request, context) => {
      const call = { module: id, method, request, params: await context.params }
      calls.push(call)
      return responder(call)
    }]))
  })
  return { ...dispatch, calls, imports }
}

function routeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? routeFiles(file) : entry.name === 'route.ts' ? [file] : []
  })
}

function exportedMethods(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && methods.includes(statement.name?.text)).map(statement => statement.name.text).sort()
}

function operationInput(operation) {
  return {
    ...(operation.params.length ? { params: Object.fromEntries(operation.params.map(name => [name, validId])) } : {}),
    ...(operation.bodyMode === 'json' ? { body: operation.actions.length ? { action: operation.actions[0] } : {} } : {}),
    ...(operation.bodyMode === 'multipart' ? { form: {} } : {}),
  }
}

test('all 98 business operations cover every exported method of 54 selected routes', () => {
  const operations = catalog.listBusinessOperations()
  assert.equal(operations.length, 98)
  assert.equal(new Set(operations.map(operation => operation.id)).size, 98)
  const selected = new Set(operations.map(operation => operation.path))
  assert.equal(selected.size, 54)
  for (const route of selected) {
    const file = path.join(root, 'app', `${route.slice(1)}/route.ts`)
    assert.deepEqual(Array.from(operations.filter(operation => operation.path === route), operation => operation.method).sort(), exportedMethods(file))
  }
  assert.equal(catalog.getBusinessOperation('auth.login'), undefined)
})

test('90-route inventory has only the 54 business routes and 36 explicit control exclusions', () => {
  const routes = routeFiles(path.join(root, 'app/api')).map(file => `/${path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).join('/')}`)
  assert.equal(routes.length, 90)
  const selected = new Set(catalog.listBusinessOperations().map(operation => operation.path))
  const excluded = routes.filter(route => !selected.has(route))
  assert.equal(excluded.length, 36)
  const controlRoute = /^(?:\/api\/(?:auth|cron|integrations|data|time-clock|push)\/|\/api\/admin\/(?:codex-mtg|data-connections)$|\/api\/attendance\/time-clock$|\/api\/(?:image-proxy|ogp)$|\/api\/sos\/receipt$)/
  for (const route of excluded) assert.match(route, controlRoute, `Unreviewed coverage gap: ${route}`)
  for (const route of selected) assert.ok(!controlRoute.test(route), `Control endpoint was exposed: ${route}`)
})

test('every registered operation resolves its fixed module and method without a network request', async () => {
  const f = fixture()
  for (const operation of catalog.listBusinessOperations()) {
    const result = await f.dispatchBusinessOperation(operation.id, operationInput(operation))
    assert.equal(result.status, 200, operation.id)
    const call = f.calls.at(-1)
    assert.equal(call.module, `@/app${operation.path}/route`)
    assert.equal(call.method, operation.method)
    assert.equal(call.request.method, operation.method)
  }
  assert.equal(f.calls.length, 98)
})

test('unknown operation, endpoint, method, path IDs and query names cannot select another handler', async () => {
  const f = fixture()
  const cases = [
    ['http.request', {}, 404],
    ['users.list', { endpoint: '/api/auth/me' }, 400],
    ['users.list', { method: 'DELETE' }, 400],
    ['users.list', { params: { id: validId } }, 400],
    ['users.list', { query: { endpoint: 'https://example.invalid' } }, 400],
    ['groups.members.list', {}, 400],
    ['groups.members.list', { params: { id: '../auth/me' } }, 400],
    ['groups.members.list', { params: { id: validId, endpoint: '/api/auth/me' } }, 400],
    ['payroll.imports.analyze', { params: { batchId: 'not-a-uuid' } }, 400],
    ['attendance.admin.list', { query: { user_id: { id: validId } } }, 400],
    ['attendance.admin.list', { query: { user_id: `prefix\0${validId}` } }, 400],
    ['attendance.admin.list', { query: { user_id: Infinity } }, 400],
  ]
  for (const [id, input, status] of cases) assert.equal((await f.dispatchBusinessOperation(id, input)).status, status)
  assert.equal(f.imports.length, 0)
  assert.equal(f.calls.length, 0)
})

test('path UUIDs and approved query scalars reach only the canonical URL without session credentials', async () => {
  const f = fixture()
  await f.dispatchBusinessOperation('groups.members.list', { params: { id: validId } })
  const member = f.calls.at(-1)
  assert.equal(member.request.url, `https://v0-line-blush.vercel.app/api/groups/${validId}/members`)
  assert.equal(member.params.id, validId)
  await f.dispatchBusinessOperation('posts.list', { query: { group_id: validId, limit: 10, parent_only: true } })
  const request = f.calls.at(-1).request
  assert.equal(request.nextUrl.searchParams.get('limit'), '10')
  assert.equal(request.nextUrl.searchParams.get('parent_only'), 'true')
  assert.equal(request.headers.get('cookie'), null)
  assert.equal(request.headers.get('authorization'), null)
  assert.equal(request.headers.get('x-user-id'), null)
  assert.equal(request.headers.get('origin'), 'https://v0-line-blush.vercel.app')
})

test('SOS heartbeat and unsupported actions are rejected before any route module is imported', async () => {
  const f = fixture()
  assert.equal((await f.dispatchBusinessOperation('sos.update', { body: { action: 'heartbeat' } })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('sos.update', { body: { action: 'trigger', id: validId } })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('leave.admin.update', { body: { action: 'delete_everything' } })).status, 400)
  assert.equal(f.imports.length, 0)
  assert.equal((await f.dispatchBusinessOperation('sos.update', { body: { action: 'acknowledge', id: validId } })).status, 200)
})

test('JSON contracts reject multipart, GET bodies, arrays and oversized payloads', async () => {
  const f = fixture()
  assert.equal((await f.dispatchBusinessOperation('users.list', { body: {} })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('users.list', { files: [] })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('users.update', { body: [] })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('users.update', { form: {} })).status, 400)
  assert.equal((await f.dispatchBusinessOperation('users.update', { body: { display_name: 'a'.repeat(MAX_JSON) } })).status, 400)
  assert.equal(f.calls.length, 0)
})

test('multipart uses actual File bytes, preserves form fields and returns the existing handler status', async () => {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic resume', 'utf8')
  const f = fixture(async ({ request }) => {
    const form = await request.formData()
    assert.equal(form.get('employee_id'), validId)
    const file = form.get('file')
    assert.ok(file instanceof File)
    assert.equal(file.name, 'resume.pdf')
    assert.equal(file.type, 'application/pdf')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
    return Response.json({ document_id: validId }, { status: 201, headers: { 'set-cookie': 'never-return-this=1' } })
  })
  const result = await f.dispatchBusinessOperation('hr.resumes.upload', {
    form: { employee_id: validId },
    files: [{ field: 'file', name: 'resume.pdf', type: 'application/pdf', base64: bytes.toString('base64') }],
  })
  assert.equal(result.status, 201)
  assert.equal(result.body.document_id, validId)
  assert.equal(Object.hasOwn(result, 'headers'), false)
})

test('multipart rejects unknown fields, invalid base64, unsafe names/types, excess files and aggregate size', async () => {
  const f = fixture()
  const good = { field: 'file', name: 'file.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-test').toString('base64') }
  const cases = [
    { body: {} },
    { form: { arbitrary_path: 'C:/private' } },
    { files: [{ ...good, field: 'owner_id' }] },
    { files: [{ ...good, base64: 'data:application/pdf;base64,JVBERg==' }] },
    { files: [{ ...good, base64: 'YWJj===!' }] },
    { files: [{ ...good, base64: 'YR==' }] },
    { files: [{ ...good, name: '../file.pdf' }] },
    { files: [{ ...good, type: 'application/pdf\r\nCookie: secret' }] },
    { files: Array.from({ length: 13 }, () => good) },
    { files: [{ ...good, base64: Buffer.alloc(MAX_BINARY + 1, 1).toString('base64') }] },
  ]
  for (const input of cases) assert.equal((await f.dispatchBusinessOperation('files.upload', input)).status, 400)
  const oneMiB = Buffer.alloc(MAX_BINARY / 2, 1).toString('base64')
  const total = await f.dispatchBusinessOperation('attendance.submission.send', {
    files: [
      { ...good, field: 'new_employee_files', base64: oneMiB },
      { ...good, field: 'doc_scanner_files', base64: oneMiB },
      { ...good, field: 'doc_scanner_files', base64: 'YQ==' },
    ],
  })
  assert.equal(total.status, 400)
  assert.equal(f.calls.length, 0)
})

test('binary output is bounded base64 with a safe decoded filename and no response headers', async () => {
  const bytes = Buffer.from('%PDF-synthetic-output')
  const f = fixture(() => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': "inline; filename*=UTF-8''%E8%AA%93%E7%B4%84%2Ftest.pdf", 'set-cookie': 'secret=not-exposed' },
  }))
  const result = await f.dispatchBusinessOperation('hr.resumes.download', { query: { document_id: validId } })
  assert.equal(result.status, 200)
  assert.equal(result.file.name, '誓約_test.pdf')
  assert.equal(result.file.type, 'application/pdf')
  assert.deepEqual(Buffer.from(result.file.base64, 'base64'), bytes)
  assert.equal(Object.hasOwn(result, 'headers'), false)
  const oversized = fixture(() => new Response(Buffer.alloc(MAX_BINARY + 1), { headers: { 'content-type': 'application/pdf' } }))
  assert.equal((await oversized.dispatchBusinessOperation('hr.resumes.download', { query: { document_id: validId } })).status, 413)
})

test('JSON output preserves business errors, rejects invalid JSON and bounds large responses', async () => {
  const conflict = fixture(() => Response.json({ error: 'synthetic version conflict' }, { status: 409 }))
  const result = await conflict.dispatchBusinessOperation('appraisals.save', { body: { employeeId: validId } })
  assert.equal(result.status, 409)
  assert.equal(result.body.error, 'synthetic version conflict')
  const invalid = fixture(() => new Response('{broken', { headers: { 'content-type': 'application/json' } }))
  assert.equal((await invalid.dispatchBusinessOperation('users.list', {})).status, 502)
  const large = fixture(() => Response.json({ records: 'a'.repeat(MAX_JSON) }))
  assert.equal((await large.dispatchBusinessOperation('users.list', {})).status, 413)
})

test('ten existing GET workflows with changes explicitly declare side effects and require write handling', () => {
  const sideEffects = catalog.listBusinessOperations().filter(operation => operation.method === 'GET' && !operation.readOnly)
  assert.deepEqual(Array.from(sideEffects, operation => operation.id).sort(), [
    'calendar.events.list', 'chat.messages.list', 'company-messages.list', 'leave.admin.list', 'leave.own', 'pledges.own', 'posts.list', 'shifts.admin.list', 'shifts.requests.list', 'tasks.list',
  ])
  for (const operation of sideEffects) assert.ok(operation.sideEffects?.length)
  assert.equal(catalog.getBusinessOperation('users.list').readOnly, true)
  assert.equal(catalog.getBusinessOperation('files.upload').readOnly, false)
})
