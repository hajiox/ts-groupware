const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../app/api/admin/payroll/mail-jobs/route.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const calls = []
let user = null, allowed = true, dbError = false, namesError = false
let jobs = [{ id: 'synthetic-job', status: 'needs_operator', report_status: 'pending', reason: 'month_unknown', comparison: { rows: [{ employeeId: 'synthetic-employee' }, { employeeId: 'synthetic-employee' }] } }]
const dependencies = {
  'next/server': { NextResponse: { json: (data, init) => new Response(JSON.stringify(data), init) } },
  '@/lib/session': { getUserSession: async () => user },
  '@/lib/management-permissions': { getManagementPermissions: () => ({ canViewPayroll: allowed }) },
  '@/lib/supabase/admin': { adminClient: { from: table => {
    calls.push(['from', table])
    const query = {
      select: fields => { calls.push(['select', fields]); return query },
      order: (field, order) => { calls.push(['order', field, order]); return query },
      limit: async value => { assert.equal(value, 24); return { data: jobs, error: dbError ? { message: 'secret database diagnostic' } : null } },
      in: async (field, values) => { assert.equal(field, 'id'); assert.deepEqual(values, ['synthetic-employee']); return { data: [{ id: 'synthetic-employee', real_name: 'Synthetic staff', display_name: 'Synthetic' }], error: namesError && { message: 'secret name diagnostic' } } },
    }
    return query
  } } },
}
const loaded = { exports: {} }
new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, name => dependencies[name] || require(name))
;(async () => {
  assert.equal((await loaded.exports.GET()).status, 401)
  assert.equal(calls.length, 0)
  user = { id: 'synthetic-principal' }
  allowed = false
  assert.equal((await loaded.exports.GET()).status, 403)
  assert.equal(calls.length, 0)
  allowed = true
  let response = await loaded.exports.GET()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const result = await response.json()
  assert.equal(result.jobs[0].reason, 'month_unknown')
  assert.equal(result.jobs[0].report_status, 'pending')
  assert.deepEqual(result.employees, [{ id: 'synthetic-employee', name: 'Synthetic staff' }])
  assert.ok(calls.some(item => item[0] === 'select' && item[1].includes('comparison')))
  dbError = true
  response = await loaded.exports.GET()
  assert.equal(response.status, 500)
  assert.ok(!(await response.text()).includes('secret'))
  dbError = false
  namesError = true
  assert.equal((await loaded.exports.GET()).status, 500)
  namesError = false
  jobs = [{ comparison: { rows: 'malformed legacy data' } }]
  response = await loaded.exports.GET()
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).employees, [])
  console.log('Payroll mail jobs API: authentication, payroll permission, saved outcomes, names, bounded query and private errors passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
