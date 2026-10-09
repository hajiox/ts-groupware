import { inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

const MIB = 1024 * 1024
const MAX_ARCHIVE_SIZE = 3 * MIB
const MAX_ENTRY_SIZE = 20 * MIB
const MAX_TOTAL_SIZE = 80 * MIB
const MAX_COMPRESSION_RATIO = 200

export class PayrollMailArchiveError extends Error {
  constructor(public readonly code: string) {
    // Never include a workbook cell, employee name, amount or archive name here.
    super(`給与ZIPを安全に確認できませんでした (${code})`)
    this.name = 'PayrollMailArchiveError'
  }
}

function reject(code: string): never {
  throw new PayrollMailArchiveError(code)
}

export type PayrollMailArchiveEntry = {
  path: string
  name: string
  size: number
  crc32: string
}

type CheckedEntry = PayrollMailArchiveEntry & { content: Buffer; directory: boolean }
type ArchiveLimits = { maxBytes: number; maxEntries: number; office?: boolean }

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

function crc32(buffer: Buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function decodedName(raw: Buffer, utf8: boolean) {
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'shift_jis', { fatal: true }).decode(raw)
  } catch {
    return reject('zip_name_encoding')
  }
}

function checkExtra(extra: Buffer, rawName: Buffer, fallback: string) {
  let offset = 0
  let name = fallback
  const seen = new Set<number>()
  while (offset < extra.length) {
    if (offset + 4 > extra.length) reject('zip_extra_invalid')
    const kind = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    offset += 4
    if (offset + size > extra.length || seen.has(kind)) reject('zip_extra_invalid')
    seen.add(kind)
    if (kind === 0x0001) reject('zip64_unsupported')
    if (kind === 0x7075) {
      if (size < 5 || extra[offset] !== 1 || extra.readUInt32LE(offset + 1) !== crc32(rawName)) reject('zip_unicode_path_invalid')
      name = decodedName(extra.subarray(offset + 5, offset + size), true)
    }
    offset += size
  }
  return name
}

function checkedPath(raw: string) {
  const normalized = raw.normalize('NFKC').replace(/\\/g, '/')
  const directory = normalized.endsWith('/')
  const pieces = normalized.replace(/\/$/, '').split('/')
  if (!normalized || normalized.length > 500 || /[\x00-\x1f\x7f:]/.test(normalized)
    || normalized.startsWith('/') || pieces.some((piece) => !piece || piece === '.' || piece === '..')) reject('zip_path_invalid')
  // NFC keeps the original Japanese filename while rejecting equivalent aliases.
  const path = raw.normalize('NFC').replace(/\\/g, '/')
  return { path, key: normalized.toLowerCase(), directory }
}

function checkedZip(buffer: Buffer, limits: ArchiveLimits): CheckedEntry[] {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > limits.maxBytes) reject('zip_size_limit')
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset
      break
    }
  }
  if (end < 0) reject('zip_directory_invalid')
  const count = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralStart = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) reject('zip64_unsupported')
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) reject('zip_multi_disk_unsupported')
  if (!count || count > limits.maxEntries) reject('zip_entry_limit')
  if (centralStart + centralSize !== end || centralStart < 30) reject('zip_directory_invalid')

  let offset = centralStart
  let totalSize = 0
  const names = new Set<string>()
  const entries: CheckedEntry[] = []
  const ranges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) reject('zip_directory_invalid')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const checksum = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameSize = buffer.readUInt16LE(offset + 28)
    const extraSize = buffer.readUInt16LE(offset + 30)
    const commentSize = buffer.readUInt16LE(offset + 32)
    const disk = buffer.readUInt16LE(offset + 34)
    const attributes = buffer.readUInt32LE(offset + 38)
    const localStart = buffer.readUInt32LE(offset + 42)
    const next = offset + 46 + nameSize + extraSize + commentSize
    if (next > end || !nameSize) reject('zip_directory_invalid')
    if (size === 0xffffffff || compressedSize === 0xffffffff || localStart === 0xffffffff) reject('zip64_unsupported')
    if (flags & 0x0041) reject('zip_encrypted')
    if ((flags & ~0x080e) || disk || ![0, 8].includes(method)) reject('zip_format_unsupported')
    if ((attributes >>> 16 & 0xf000) === 0xa000) reject('zip_symlink')
    if (size > MAX_ENTRY_SIZE || (totalSize += size) > MAX_TOTAL_SIZE) reject('zip_expansion_limit')
    if (size > Math.max(1, compressedSize) * MAX_COMPRESSION_RATIO) reject('zip_compression_ratio')
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameSize)
    const name = checkExtra(buffer.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize), rawName, decodedName(rawName, Boolean(flags & 0x0800)))
    const path = checkedPath(name)
    if (names.has(path.key)) reject('zip_duplicate_path')
    names.add(path.key)
    if (/\.zip$/i.test(path.path)) reject('zip_nested_archive')
    if (path.directory && (size || compressedSize)) reject('zip_directory_invalid')

    if (localStart + 30 > centralStart || buffer.readUInt32LE(localStart) !== 0x04034b50) reject('zip_local_header_invalid')
    const localNameSize = buffer.readUInt16LE(localStart + 26)
    const localExtraSize = buffer.readUInt16LE(localStart + 28)
    const dataStart = localStart + 30 + localNameSize + localExtraSize
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralStart || buffer.readUInt16LE(localStart + 6) !== flags || buffer.readUInt16LE(localStart + 8) !== method
      || !buffer.subarray(localStart + 30, localStart + 30 + localNameSize).equals(rawName)) reject('zip_local_header_invalid')
    const localName = checkExtra(buffer.subarray(localStart + 30 + localNameSize, dataStart), rawName, decodedName(rawName, Boolean(flags & 0x0800)))
    if (localName !== name) reject('zip_local_header_invalid')
    let recordEnd = dataEnd
    if (flags & 8) {
      const signature = dataEnd + 4 <= centralStart && buffer.readUInt32LE(dataEnd) === 0x08074b50
      const descriptor = dataEnd + (signature ? 4 : 0)
      if (descriptor + 12 > centralStart || buffer.readUInt32LE(descriptor) !== checksum
        || buffer.readUInt32LE(descriptor + 4) !== compressedSize || buffer.readUInt32LE(descriptor + 8) !== size) reject('zip_descriptor_invalid')
      recordEnd = descriptor + 12
    } else if (buffer.readUInt32LE(localStart + 14) !== checksum || buffer.readUInt32LE(localStart + 18) !== compressedSize
      || buffer.readUInt32LE(localStart + 22) !== size) reject('zip_local_header_invalid')
    ranges.push({ start: localStart, end: recordEnd })

    let content: Buffer
    try {
      content = method === 0 ? buffer.subarray(dataStart, dataEnd)
        : inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, size) })
    } catch {
      return reject('zip_expansion_invalid')
    }
    if (content.length !== size || crc32(content) !== checksum) reject('zip_crc_invalid')
    if (!limits.office && content.length >= 4 && content.readUInt32LE(0) === 0x04034b50 && !/\.xlsx$/i.test(path.path)) reject('zip_nested_archive')
    entries.push({ path: path.path, name: path.path.replace(/\/$/, '').split('/').pop() || '', size, crc32: checksum.toString(16).padStart(8, '0'), content, directory: path.directory })
    offset = next
  }
  if (offset !== end) reject('zip_directory_invalid')
  ranges.sort((a, b) => a.start - b.start)
  let expectedOffset = 0
  for (const range of ranges) {
    if (range.start !== expectedOffset) reject('zip_overlapping_entries')
    expectedOffset = range.end
  }
  if (expectedOffset !== centralStart) reject('zip_local_header_invalid')
  return entries
}

const ITEM_LABELS = new Set([
  '出勤日数', '休日出勤日数', '代休日数', '有給日数', '特別休暇日数', '欠勤日数', '就労時間',
  '普通残業', '深夜勤務', '休日勤務時間', '道の駅勤務時間', 'しこん勤務時間', 'ﾌﾞﾗﾝﾄﾞ館勤務',
  '研修時間', '遡及時間', '早出時間', '遅早回数', '遅早時間', '法定休日勤務時間', '土日祝勤務',
  '月60時間超残業', '本給', '基本給', '土日祝勤手当', '特別手当', '技能手当', '住宅手当', '育児手当',
  '課税通勤手当', '超過勤務手当', '遡及手当', '深夜手当', '休日出勤手当', '基本給2', 'GW特別手当',
  '有給買取手当', '欠勤控除', '遅早控除', 'お盆特別手当', 'コロナ休業手当', '慰労金', '非課税通勤手当',
  '解雇予告手当', '健康保険', '介護保険', '子ども子育て支援金', '厚生年金', '雇用保険', '調整保険',
  '所得税', '住民税', 'その他控除', '社宅家賃', '年調精算額', '供託金',
  '平日土曜残業', '日曜残業', '月60時間超手当',
])
const TOTAL_LABELS = new Set([
  '課税支給合計', '非課税支給合計', '支給合計', '社保控除合計', '課税対象額', '定額減税',
  'その他控除合計', '控除合計', '差引支給額', '現金支給額', '振込支給額', '税制扶養数', '税表区分',
])
const REQUIRED_TOTALS = ['課税支給合計', '非課税支給合計', '支給合計', '社保控除合計', '課税対象額', '控除合計', '差引支給額']

function monthStart(value: string) {
  if (!/^20\d{2}-(?:0[1-9]|1[0-2])(?:-01)?$/.test(value)) reject('month_invalid')
  return `${value.slice(0, 7)}-01`
}

function previousMonth(value: string) {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10)
}

function cells(book: XLSX.WorkBook, name: string) {
  const sheet = book.Sheets[name]
  const range = sheet?.['!fullref'] || sheet?.['!ref']
  if (!range) reject('workbook_empty')
  const bounds = XLSX.utils.decode_range(range)
  if (bounds.e.r >= 500 || bounds.e.c >= 64) reject('workbook_dimensions')
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true })
}

function readWorkbook(entry: CheckedEntry) {
  checkedZip(entry.content, { maxBytes: MAX_ENTRY_SIZE, maxEntries: 1000, office: true })
  try {
    const book = XLSX.read(entry.content, { type: 'buffer', cellDates: true, sheetRows: 501 })
    if (!book.SheetNames.length || book.SheetNames.length > 200) reject('workbook_dimensions')
    return book
  } catch (error) {
    if (error instanceof PayrollMailArchiveError) throw error
    return reject('workbook_invalid')
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '') : ''
}

function numeric(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && /^-?\d+(?:,\d{3})*(?:\.\d+)?$/.test(value.trim())
}

function validateStatement(book: XLSX.WorkBook, payrollMonth: string) {
  let employees = 0
  let reportedSheets = 0
  for (const sheet of book.SheetNames) {
    const rows = cells(book, sheet)
    const header = text(rows[0]?.[0]).match(/^(20\d{2})年(\d{1,2})月(?:分|度)?$/)
    if (!header || `${header[1]}-${header[2].padStart(2, '0')}-01` !== payrollMonth) reject('statement_month_mismatch')
    const hasReportedTotal = /^\d+名$/.test(text(rows[5]?.[5]))
    if (hasReportedTotal) reportedSheets += 1
    const columns = [1, 2, 3, 4, 5].filter((column) => text(rows[5]?.[column]) && !/^\d+名$/.test(text(rows[5]?.[column])))
    const labels = new Map<string, unknown[]>()
    const dualLabels = new Map<string, number>()
    for (let index = 6; index < rows.length; index += 1) {
      const label = String(rows[index]?.[0] || '').trim()
      if (!label) continue
      if (labels.has(label)) {
        const populated = columns.some((column) => rows[index]?.[column] != null && rows[index]?.[column] !== '' && rows[index]?.[column] !== 0)
        if (!TOTAL_LABELS.has(label) && !populated) continue
        // The provider uses the same caption for time and money in two bands.
        if (!['平日土曜残業', '日曜残業'].includes(label) || dualLabels.has(label)
          || index + 1 < 35 || (rows.indexOf(labels.get(label)!) + 1) >= 35) reject('statement_duplicate_item')
        dualLabels.set(label, index)
      }
      labels.set(label, rows[index])
      if (!ITEM_LABELS.has(label) && !TOTAL_LABELS.has(label)
        && columns.some((column) => rows[index]?.[column] != null && rows[index]?.[column] !== '' && rows[index]?.[column] !== 0)) reject('statement_unknown_item')
    }
    for (const label of REQUIRED_TOTALS) {
      const row = labels.get(label)
      // The provider leaves zero totals blank; a missing row is never a zero.
      if (!row || [...columns, ...(hasReportedTotal ? [5] : [])].some((column) => row[column] != null && row[column] !== '' && !numeric(row[column]))) reject('statement_total_missing')
    }
    const payment = labels.get('支給合計')!
    const net = labels.get('差引支給額')!
    if (hasReportedTotal && (!numeric(payment[5]) || !numeric(net[5]))) reject('statement_total_missing')
    // Real employees with zero salary remain part of the reported headcount.
    employees += columns.length
    const number = (value: unknown) => value == null || value === '' ? 0 : Number(String(value).replace(/,/g, ''))
    for (const column of columns) {
      if (number(labels.get('課税支給合計')?.[column]) + number(labels.get('非課税支給合計')?.[column]) !== number(payment[column])
        || number(payment[column]) - number(labels.get('控除合計')?.[column]) !== number(net[column])) reject('statement_employee_totals_mismatch')
    }
  }
  if (!reportedSheets) reject('statement_headcount_missing')
  if (!employees) reject('statement_no_employees')
}

function validateLedger(book: XLSX.WorkBook, payrollMonth: string, attendanceMonth: string) {
  const payrollNumber = Number(payrollMonth.slice(5, 7))
  const attendanceNumber = Number(attendanceMonth.slice(5, 7))
  const lastDay = new Date(Date.UTC(Number(attendanceMonth.slice(0, 4)), attendanceNumber, 0)).getUTCDate()
  const names = new Map<string, string>()
  const codes = new Set<string>()
  let payDate: string | null = null
  let employeeSheets = 0
  for (const sheet of book.SheetNames) {
    const identity = sheet.normalize('NFKC').match(/^\((\d+)\)(.+)$/)
    if (!identity) reject('ledger_sheet_unsupported')
    employeeSheets += 1
    const name = identity[2].replace(/[\s　・･]/g, '')
    const code = String(Number(identity[1]))
    if (!name || !Number.isSafeInteger(Number(code)) || Number(code) < 1 || names.has(name) || codes.has(code)) reject('ledger_employee_ambiguous')
    names.set(name, code)
    codes.add(code)
    const rows = cells(book, sheet)
    const ledgerYear = text(rows[0]?.[8]).match(/^(20\d{2})年度?分賃金台帳$/)
    if (!ledgerYear || ledgerYear[1] !== payrollMonth.slice(0, 4)) reject('ledger_year_mismatch')
    const candidates: Array<{ column: number; day: number }> = []
    for (let column = 1; column < (rows[3]?.length || 0); column += 1) {
      const date = text(rows[3]?.[column]).match(/^(\d{1,2})月(\d{1,2})日$/)
      if (date && Number(date[1]) === payrollNumber) candidates.push({ column, day: Number(date[2]) })
    }
    if (candidates.length !== 1) reject('ledger_payroll_month_missing')
    const { column, day } = candidates[0]
    const monthDays = new Date(Date.UTC(Number(payrollMonth.slice(0, 4)), payrollNumber, 0)).getUTCDate()
    if (day < 1 || day > monthDays) reject('ledger_pay_date_invalid')
    const attendance = text(rows[4]?.[column]).match(/^(\d{1,2})月(\d{1,2})日[～〜~\-](\d{1,2})月(\d{1,2})日$/)
    if (!attendance || Number(attendance[1]) !== attendanceNumber || Number(attendance[2]) !== 1
      || Number(attendance[3]) !== attendanceNumber || Number(attendance[4]) !== lastDay) reject('ledger_attendance_month_mismatch')
    const selectedPayDate = `${payrollMonth.slice(0, 7)}-${String(day).padStart(2, '0')}`
    if (payDate && payDate !== selectedPayDate) reject('ledger_pay_date_mismatch')
    payDate = selectedPayDate
  }
  if (!employeeSheets || !payDate) reject('ledger_empty')
  return payDate
}

export async function parsePayrollMailArchive(
  originalBuffer: Buffer,
  expected: { payrollMonth: string; attendanceMonth: string },
) {
  const payrollMonth = monthStart(expected.payrollMonth)
  const attendanceMonth = monthStart(expected.attendanceMonth)
  if (attendanceMonth !== previousMonth(payrollMonth)) reject('attendance_policy_mismatch')
  const entries = checkedZip(originalBuffer, { maxBytes: MAX_ARCHIVE_SIZE, maxEntries: 200 }).filter((entry) => !entry.directory)
  const statements = entries.filter((entry) => /支給控除一覧表(?:_rev\d+)?\.xlsx$/i.test(entry.name))
  const ledgers = entries.filter((entry) => /賃金台帳(?:_rev\d+)?\.xlsx$/i.test(entry.name) && !entry.name.includes('全社計'))
  if (statements.length !== 1 || ledgers.length !== 1) reject('required_workbook_ambiguous')
  const statement = statements[0]
  const ledger = ledgers[0]
  validateStatement(readWorkbook(statement), payrollMonth)
  const payDate = validateLedger(readWorkbook(ledger), payrollMonth, attendanceMonth)

  // Only verified workbook bytes and canonical filenames reach the legacy parser.
  // Store/hash originalBuffer separately as the immutable source evidence.
  const verifiedZip = new JSZip()
  verifiedZip.file(statement.path, statement.content)
  verifiedZip.file(ledger.path, ledger.content)
  const buffer = await verifiedZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  return {
    buffer,
    payrollMonth,
    attendanceMonth,
    payDate,
    statementWorkbook: statement.path,
    ledgerWorkbook: ledger.path,
    entries: entries.map(({ path, name, size, crc32: checksum }): PayrollMailArchiveEntry => ({ path, name, size, crc32: checksum })),
  }
}
