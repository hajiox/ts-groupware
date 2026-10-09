const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const JSZip = require('jszip')
const XLSX = require('xlsx')

// All inputs are synthetic. Importing the parser cannot reach Drive or a DB.
function load(file) {
  const mod = { exports: {} }
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  new Function('module', 'exports', 'require', output)(mod, mod.exports, (name) => {
    if (name.startsWith('@/')) return new Proxy({}, { get() { throw new Error('No external access in archive tests') } })
    return require(name)
  })
  return mod.exports
}
const { parsePayrollMailArchive, PayrollMailArchiveError } = load('lib/payroll-mail-archive.ts')
const { parseLaborPayrollZip } = load('lib/labor-payroll-zip.ts')
const expected = { payrollMonth: '2026-10', attendanceMonth: '2026-09' }

function workbook(sheets) {
  const book = XLSX.utils.book_new()
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name)
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}

function statement(options = {}) {
  if (options.emptyStatement) return workbook([['検証', []]])
  const rows = [[options.wrongMonth ? '2026年9月分' : '2026年10月分'], [], [], [], [], ['', '試験社員', '', '', '', '1名'],
    ['基本給', 100], ['課税支給合計', 100, '', '', '', 100], ['非課税支給合計', null, '', '', '', null],
    ['支給合計', 100, '', '', '', options.companyMismatch ? 101 : 100], ['社保控除合計', null, '', '', '', null],
    ['課税対象額', 100, '', '', '', 100], ['供託金', 10], ['控除合計', 10, '', '', '', 10],
    ['差引支給額', options.employeeMismatch ? 91 : 90, '', '', '', 90]]
  if (options.missingTotal) rows.splice(rows.findIndex((row) => row[0] === '控除合計'), 1)
  if (options.unknownItem) rows.push(['新しい未対応手当', 5])
  if (options.duplicateTotal) rows.push(['支給合計', 100])
  if (options.invalidNumber) rows.find((row) => row[0] === '支給合計')[1] = '未確定'
  if (options.noEmployees) {
    rows[5][1] = ''
    rows[5][5] = '0名'
  }
  return workbook([['検証', rows]])
}

function ledger(options = {}) {
  const rows = Array.from({ length: 7 }, () => [])
  rows[0][0] = '賃金台帳'
  rows[0][8] = options.wrongYear ? '2025年度分 賃金台帳' : '2026年度分 賃金台帳'
  rows[3][1] = options.missingPayMonth ? '09月10日' : options.badPayDay ? '10月99日' : '10月09日'
  rows[4][1] = options.wrongAttendance ? '08月01日～08月31日' : '09月01日～09月30日'
  const sheets = [['(901)試験社員', rows]]
  if (options.duplicateLedgerEmployee) sheets.push(['(902)試験社員', rows])
  if (options.ambiguousPayMonth) { rows[3][2] = '10月10日'; rows[4][2] = '09月01日～09月30日' }
  return workbook(sheets)
}

async function fixture(options = {}) {
  const zip = new JSZip()
  const suffix = options.revision ? '_rev2' : ''
  const statementBytes = statement(options)
  if (options.innerExpansionLimit) statementBytes.writeUInt32LE(20 * 1024 * 1024 + 1, directory(statementBytes) + 24)
  if (options.innerCrcFailure) {
    const entry = directory(statementBytes), start = statementBytes.readUInt32LE(entry + 42)
    const data = start + 30 + statementBytes.readUInt16LE(start + 26) + statementBytes.readUInt16LE(start + 28)
    statementBytes[data] ^= 1
  }
  zip.file(`Excel/2026.10支給控除一覧表${suffix}.xlsx`, statementBytes)
  if (!options.noLedger) zip.file(`Excel/2026年賃金台帳${suffix}.xlsx`, ledger(options))
  zip.file('PDF/説明.pdf', Buffer.from('%PDF-synthetic'))
  if (options.duplicateStatement) zip.file('Other/支給控除一覧表.xlsx', statement())
  if (options.path) zip.file(options.path, Buffer.from('fixture'))
  if (options.nestedDisguise) zip.file('archive.pdf', await new JSZip().file('a.txt', 'a').generateAsync({ type: 'nodebuffer' }))
  if (options.duplicatePath) { zip.file('NOTE.pdf', 'A'); zip.file('note.PDF', 'B') }
  if (options.symlink) zip.file('link.txt', 'fixture', { unixPermissions: 0o120777 })
  if (options.entryLimit) for (let i = 0; i < 201; i++) zip.file(`extra/${i}.txt`, 'x')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: options.symlink ? 'UNIX' : 'DOS', streamFiles: options.streamFiles || false })
}

function directory(buffer) {
  const end = buffer.length - 22
  return buffer.readUInt32LE(end + 16)
}
function centralFor(buffer, ending) {
  let offset = directory(buffer)
  while (buffer.readUInt32LE(offset) === 0x02014b50) {
    const nameSize = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8')
    if (name.endsWith(ending)) return offset
    offset += 46 + nameSize + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  throw new Error('Fixture entry missing')
}
function mutate(buffer, change) { const copy = Buffer.from(buffer); change(copy); return copy }
async function refuses(buffer, code, contract = expected) {
  await assert.rejects(parsePayrollMailArchive(buffer, contract), (error) => {
    assert.ok(error instanceof PayrollMailArchiveError)
    assert.equal(error.code, code)
    assert.equal(error.message, `給与ZIPを安全に確認できませんでした (${code})`)
    return true
  })
}

async function main() {
  const original = await fixture()
  for (const options of [{}, { revision: true }, { streamFiles: true }]) {
    const archive = await parsePayrollMailArchive(await fixture(options), expected)
    assert.equal(archive.payrollMonth, '2026-10-01')
    assert.equal(archive.attendanceMonth, '2026-09-01')
    assert.equal(archive.payDate, '2026-10-09')
    assert.equal(archive.entries.length, 3)
    assert.ok(archive.entries.every((entry) => /^[a-f0-9]{8}$/.test(entry.crc32)))
    const zip = await JSZip.loadAsync(archive.buffer)
    assert.equal(Object.values(zip.files).filter((entry) => !entry.dir).length, 2)
    const result = await parseLaborPayrollZip(archive.buffer)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].items.find((item) => item.code === 'deposit_money').amount, 10)
    assert.equal(result.totals.netPayment, 90)
  }
  const oldLabels = [...fs.readFileSync('lib/labor-payroll-zip.ts', 'utf8').matchAll(/^  '([^']+)': \{ code:/gm)].map((match) => match[1])
  const safeSource = fs.readFileSync('lib/payroll-mail-archive.ts', 'utf8')
  for (const label of oldLabels) assert.ok(safeSource.includes(`'${label}'`), 'Archive allowlist must include existing parser item labels')

  await refuses(Buffer.alloc(3 * 1024 * 1024 + 1), 'zip_size_limit')
  await refuses(await fixture({ entryLimit: true }), 'zip_entry_limit')
  for (const path of ['../escape.pdf', '/absolute.pdf', 'C:\\escape.pdf', 'valid/../escape.pdf']) await refuses(await fixture({ path }), 'zip_path_invalid')
  await refuses(await fixture({ path: 'nested.zip' }), 'zip_nested_archive')
  await refuses(await fixture({ nestedDisguise: true }), 'zip_nested_archive')
  await refuses(await fixture({ duplicatePath: true }), 'zip_duplicate_path')
  await refuses(await fixture({ symlink: true }), 'zip_symlink')
  await refuses(await fixture({ duplicateStatement: true }), 'required_workbook_ambiguous')
  await refuses(await fixture({ noLedger: true }), 'required_workbook_ambiguous')
  await refuses(await fixture({ emptyStatement: true }), 'workbook_empty')
  await refuses(await fixture({ innerExpansionLimit: true }), 'zip_expansion_limit')
  await refuses(await fixture({ innerCrcFailure: true }), 'zip_crc_invalid')
  await refuses(await fixture({ noEmployees: true }), 'statement_no_employees')
  await refuses(await fixture({ wrongMonth: true }), 'statement_month_mismatch')
  await refuses(await fixture({ missingTotal: true }), 'statement_total_missing')
  await refuses(await fixture({ duplicateTotal: true }), 'statement_duplicate_item')
  await refuses(await fixture({ unknownItem: true }), 'statement_unknown_item')
  await refuses(await fixture({ invalidNumber: true }), 'statement_total_missing')
  await refuses(await fixture({ employeeMismatch: true }), 'statement_employee_totals_mismatch')
  await refuses(await fixture({ wrongYear: true }), 'ledger_year_mismatch')
  await refuses(await fixture({ wrongAttendance: true }), 'ledger_attendance_month_mismatch')
  await refuses(await fixture({ missingPayMonth: true }), 'ledger_payroll_month_missing')
  await refuses(await fixture({ badPayDay: true }), 'ledger_pay_date_invalid')
  await refuses(await fixture({ ambiguousPayMonth: true }), 'ledger_payroll_month_missing')
  await refuses(await fixture({ duplicateLedgerEmployee: true }), 'ledger_employee_ambiguous')
  await refuses(original, 'attendance_policy_mismatch', { payrollMonth: '2026-10', attendanceMonth: '2026-08' })
  await refuses(original, 'month_invalid', { payrollMonth: '2026-99', attendanceMonth: '2026-09' })
  await refuses(original.subarray(0, original.length - 1), 'zip_directory_invalid')
  await refuses(mutate(original, (b) => { b.writeUInt16LE(b.readUInt16LE(directory(b) + 8) | 1, directory(b) + 8) }), 'zip_encrypted')
  await refuses(mutate(original, (b) => { b.writeUInt32LE(0xffffffff, directory(b) + 24) }), 'zip64_unsupported')
  await refuses(mutate(original, (b) => {
    const entry = centralFor(b, '説明.pdf'), start = b.readUInt32LE(entry + 42)
    const data = start + 30 + b.readUInt16LE(start + 26) + b.readUInt16LE(start + 28)
    b[data] ^= 1
  }), 'zip_crc_invalid')
  await refuses(mutate(original, (b) => { b.writeUInt32LE(20 * 1024 * 1024 + 1, directory(b) + 24) }), 'zip_expansion_limit')
  await refuses(mutate(original, (b) => {
    const entry = centralFor(b, '説明.pdf')
    b.writeUInt32LE(b.readUInt32LE(entry + 20) * 201, entry + 24)
  }), 'zip_compression_ratio')
  await refuses(mutate(original, (b) => { b[30] ^= 1 }), 'zip_local_header_invalid')
  const wrongTotal = await parsePayrollMailArchive(await fixture({ companyMismatch: true }), expected)
  await assert.rejects(parseLaborPayrollZip(wrongTotal.buffer), /全社計と一致しません/)
  console.log('Payroll archive synthetic tests passed: bounded ZIP/CRC/paths, workbook months/pay date, unsupported cells and legacy parser handoff.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
