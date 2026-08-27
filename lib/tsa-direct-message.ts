import { createHash } from 'node:crypto'

export function normalizeDirectMessageUserName(value: string) {
  return value.replace(/[\s\u3000]+/g, '').trim()
}

export function requiredDirectMessageText(value: unknown, field: string, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maxLength) throw new Error(`${field} is invalid`)
  return text
}

export function directChatKey(userIdA: string, userIdB: string) {
  return `direct:${[userIdA, userIdB].sort().join(':')}`
}

export function tsaDirectMessagePostId(sourceKey: string, recipientId: string) {
  const bytes = createHash('sha256')
    .update(`tsa_direct_message:${sourceKey}:${recipientId}`, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
