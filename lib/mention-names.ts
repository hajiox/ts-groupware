const HONORIFIC_SUFFIX_RE = /(さん|様|さま|君|くん|ちゃん)$/
const MENTION_AFTER_BOUNDARY_RE = '(?=$|[\\s　、。,.!！?？)）\\]】」』])'

const PRESIDENT_MENTION_NAME = '社長'
const PRESIDENT_PERSON_KEYS = new Set(['佐藤正彦'])

function compactPersonName(value: string) {
  return value
    .trim()
    .replace(HONORIFIC_SUFFIX_RE, '')
    .replace(/[\s　]+/g, '')
}

export function isPresidentMentionName(name?: string | null) {
  const key = compactPersonName(name || '')
  return key === PRESIDENT_MENTION_NAME || PRESIDENT_PERSON_KEYS.has(key)
}

export function mentionDisplayName(name?: string | null) {
  const trimmed = (name || '').trim()
  if (!trimmed) return ''
  return isPresidentMentionName(trimmed) ? PRESIDENT_MENTION_NAME : trimmed
}

export function formatMentionName(name: string) {
  const label = mentionDisplayName(name)
  if (!label) return ''
  if (label === PRESIDENT_MENTION_NAME) return label
  return HONORIFIC_SUFFIX_RE.test(label) ? label : `${label}さん`
}

export function normalizeMentionContent(content: string) {
  if (!content) return content

  const presidentFullName = new RegExp(
    `(^|[\\s　])@佐藤[\\s　]*正彦(?:さん|様|さま|君|くん|ちゃん)?${MENTION_AFTER_BOUNDARY_RE}`,
    'gu',
  )
  const presidentTitle = new RegExp(
    `(^|[\\s　])@${PRESIDENT_MENTION_NAME}(?:さん|様|さま|君|くん|ちゃん)?${MENTION_AFTER_BOUNDARY_RE}`,
    'gu',
  )

  return content
    .replace(presidentFullName, `$1@${PRESIDENT_MENTION_NAME}`)
    .replace(presidentTitle, `$1@${PRESIDENT_MENTION_NAME}`)
}
