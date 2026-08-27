export type FaxSummaryStatus = 'pending' | 'completed' | 'needs_review' | 'failed'

type BuildFaxPostInput = {
  sourceKey?: string
  senderLabel?: string
  from?: string
  subject?: string
  receivedAt?: unknown
  imageCount: number
  summaryStatus?: FaxSummaryStatus
  summary?: string
}

const SUMMARY_HEADING = '【AI要約】'
const PENDING_MESSAGE = '要約を作成中です。FAX画像は先に確認できます。'
const FAILED_MESSAGE = '要約を作成できませんでした。FAX画像を確認してください。'
const REVIEW_MESSAGE = '※読み取りに不確かな箇所があります。FAX画像も確認してください。'

function cleanLine(value: unknown, fallback = '') {
  const text = typeof value === 'string' ? value : ''
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() || fallback
}

export function normalizeFaxSummaryText(value: unknown) {
  return cleanLine(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 2000)
    .trim()
}

export function isFaxSummaryStatus(value: unknown): value is FaxSummaryStatus {
  return ['pending', 'completed', 'needs_review', 'failed'].includes(String(value || ''))
}

function formatDateTime(value: unknown) {
  const raw = typeof value === 'string' ? value : ''
  const date = raw ? new Date(raw) : new Date()
  if (Number.isNaN(date.getTime())) return raw || new Date().toLocaleString('ja-JP')

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function summaryBlock(status: FaxSummaryStatus, summary?: string) {
  const normalizedSummary = normalizeFaxSummaryText(summary)
  const body = status === 'pending'
    ? PENDING_MESSAGE
    : status === 'failed'
      ? FAILED_MESSAGE
      : status === 'needs_review'
        ? [REVIEW_MESSAGE, normalizedSummary].filter(Boolean).join('\n')
        : normalizedSummary || '要約結果が空でした。FAX画像を確認してください。'

  return [SUMMARY_HEADING, body]
}

function findSummaryRange(lines: string[]) {
  const start = lines.findIndex(line => line.trim() === SUMMARY_HEADING)
  if (start < 0) return null

  let end = lines.length
  for (let index = lines.length - 1; index > start; index -= 1) {
    if (lines[index].startsWith('受信ID:')) {
      end = index
      break
    }
  }
  while (end > start + 1 && lines[end - 1] === '') end -= 1
  return { start, end }
}

function extractSummaryBlock(content: string) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const range = findSummaryRange(lines)
  return range ? lines.slice(range.start, range.end) : null
}

function replaceSummaryBlock(content: string, block: string[]) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const range = findSummaryRange(lines)
  if (range) lines.splice(range.start, range.end - range.start)

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const sourceIndex = lines.findIndex(line => line.startsWith('受信ID:'))
  const insertAt = sourceIndex >= 0 ? sourceIndex : lines.length
  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)
  while (before.length > 0 && before[before.length - 1] === '') before.pop()
  return [...before, '', ...block, ...(after.length > 0 ? ['', ...after] : [])].join('\n')
}

export function buildFaxReceivedPostContent(input: BuildFaxPostInput) {
  const senderLabel = cleanLine(input.senderLabel) || cleanLine(input.from, '不明')
  const subject = cleanLine(input.subject, '(件名なし)')
  const sourceKey = cleanLine(input.sourceKey)
  const status = input.summaryStatus || 'pending'
  const base = [
    '【FAX受信】',
    'eFAXで新しいFAXを受信しました。',
    '',
    `受信日時: ${formatDateTime(input.receivedAt)}`,
    `送信元: ${senderLabel}`,
    `件名: ${subject}`,
    input.imageCount > 0 ? `FAX画像: ${input.imageCount}枚添付` : '',
    sourceKey ? `受信ID: ${sourceKey}` : '',
  ].filter(Boolean).join('\n')

  return replaceSummaryBlock(base, summaryBlock(status, input.summary))
}

export function preserveResolvedFaxSummary(existingContent: string | null, incomingContent: string) {
  const existingBlock = extractSummaryBlock(existingContent || '')
  if (!existingBlock || existingBlock.includes(PENDING_MESSAGE)) return incomingContent
  return replaceSummaryBlock(incomingContent, existingBlock)
}

export function updateFaxSummaryInContent(
  content: string | null,
  status: FaxSummaryStatus,
  summary?: string,
) {
  return replaceSummaryBlock(content || '', summaryBlock(status, summary))
}
