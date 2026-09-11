const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const XLSX = require('xlsx')
const JSZip = require('jszip')
function load(file) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', output)(mod, mod.exports, name => {
    if (name.startsWith('@/')) return new Proxy({}, { get() { throw new Error('No DB or Drive access in parser tests') } })
    return require(name)
  })
  return mod.exports
}
const { parseLaborPayrollZip, matchLaborPayrollEmployees } = load('lib/labor-payroll-zip.ts')
const { payrollAmountDelta } = load('lib/payroll-comparison.ts')
function workbook(rows, name) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name)
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}
async function fixture(revision = '', options = {}) {
  const rows = [['支給一覧'], ['対象月'], ['会社'], ['部署'], ['区分'], ['', '検証社員', '', '', '', '1名'],
    ['基本給', 100], ['支給合計', 100, '', '', '', options.wrongTotal ? 101 : 100],
    ['控除合計', 10, '', '', '', 10], ['差引支給額', 90, '', '', '', 90]]
  const zip = new JSZip()
  const statement = workbook(rows, '支給一覧')
  const ledger = workbook([['社員台帳']], '(901)検証社員')
  zip.file(`エクセル/2026.9支給控除一覧表${revision}.xlsx`, statement)
  if (!options.noLedger) zip.file(`エクセル/2026年賃金台帳${revision}.xlsx`, ledger)
  zip.file(`エクセル/2026年賃金台帳(全社計)${revision}.xlsx`, ledger)
  if (options.duplicate === 'statement') zip.file('別フォルダ/支給控除一覧表_rev2.xlsx', statement)
  if (options.duplicate === 'ledger') zip.file('別フォルダ/賃金台帳_rev2.xlsx', ledger)
  return zip.generateAsync({ type: 'nodebuffer' })
}
async function main() {
  const employee = (id, code, name, raw = {}) => ({ id, employee_code: code, display_name: name, real_name: name, user_id: id, payroll_status: 'active', raw_payload: raw })
  const employees = [
    employee('a', '146', '既存社員', { hr_profile: { payroll_name_aliases: [{ employee_code: '141', name: '旧姓社員' }] } }),
    employee('b', '149', '新規社員'),
  ]
  const sources = [{ employeeCode: '141', employeeName: '旧姓社員' }, { employeeCode: '146', employeeName: '新規社員' }]
  assert.deepEqual(matchLaborPayrollEmployees(sources, employees).map(m => m.employee.id), ['a', 'b'])
  // A historical alias code must not override a different, exact employee name.
  assert.equal(matchLaborPayrollEmployees([{ employeeCode: '141', employeeName: '新規社員' }], employees)[0].employee.id, 'b')
  assert.throws(() => matchLaborPayrollEmployees([{ employeeCode: '146', employeeName: '不明社員' }], employees), /紐付かない社員/)
  assert.throws(() => matchLaborPayrollEmployees([{ employeeCode: '999', employeeName: '新規社員' }], [...employees, employee('c', '150', '新規社員')]), /複数の対応候補/)
  assert.equal(matchLaborPayrollEmployees([{ employeeCode: '149', employeeName: '新規社員' }], [...employees, employee('c', '150', '新規社員')])[0].employee.id, 'b')
  assert.throws(() => matchLaborPayrollEmployees([sources[1], sources[1]], employees), /重複紐付け/)
  for (const revision of ['', '_rev1', '_REV12']) {
    const result = await parseLaborPayrollZip(await fixture(revision))
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].employeeCode, '901')
    assert.equal(result.totals.paymentTotal, 100)
    assert.equal(result.totals.netPayment, 90)
    assert.ok(result.sourceWorkbook.endsWith(`支給控除一覧表${revision}.xlsx`))
    assert.ok(result.wageLedgerWorkbook.endsWith(`賃金台帳${revision}.xlsx`))
  }
  for (const duplicate of ['statement', 'ledger']) {
    await assert.rejects(parseLaborPayrollZip(await fixture('_rev1', { duplicate })), /複数/)
  }
  await assert.rejects(parseLaborPayrollZip(await fixture('_rev1', { noLedger: true })), /社員別の賃金台帳/)
  await assert.rejects(parseLaborPayrollZip(await fixture('_rev1', { wrongTotal: true })), /全社計と一致しません/)
  assert.equal(payrollAmountDelta(100, null), null)
  assert.equal(payrollAmountDelta(null, 100), null)
  assert.equal(payrollAmountDelta(undefined, undefined), null)
  assert.equal(payrollAmountDelta(100, 0), 100)
  assert.equal(payrollAmountDelta(0, 100), -100)
  assert.equal(payrollAmountDelta(100, 100), 0)
  console.log('Labor ZIP original/revision parsing, ambiguous version rejection, total validation and missing-vs-zero comparison passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
