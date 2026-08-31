const HONORIFIC_SUFFIX_RE = /(さん|様|さま|君|くん|ちゃん)$/
const MENTION_AFTER_BOUNDARY_RE = '(?=$|[\\s　、。,.!！?？)）\\]】」』])'

const PRESIDENT_MENTION_NAME = '社長'
const PRESIDENT_PERSON_KEYS = new Set(['佐藤正彦'])

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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

export function appendMentionIfMissing(content: string, name: string) {
  const rawName = name.trim().replace(HONORIFIC_SUFFIX_RE, '')
  const label = mentionDisplayName(rawName)
  if (!label) return content

  const aliases = new Set([
    rawName,
    label,
    rawName.replace(/[\s　]+/g, ''),
    label.replace(/[\s　]+/g, ''),
  ].filter(Boolean))
  const alreadyMentioned = [...aliases].some((alias) => {
    const pattern = `(^|[\\s　])@${escapeRegExp(alias)}(?:さん|様|さま|君|くん|ちゃん)?${MENTION_AFTER_BOUNDARY_RE}`
    return new RegExp(pattern, 'u').test(content)
  })
  if (alreadyMentioned) return content

  const separator = !content || /[\s　]$/.test(content) ? '' : ' '
  return `${content}${separator}@${formatMentionName(name)} `
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
