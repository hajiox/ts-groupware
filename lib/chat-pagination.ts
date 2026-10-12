export type ChatCursor = { created_at: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export function encodeChatCursor(message: ChatCursor): string {
  return btoa(JSON.stringify({ created_at: message.created_at, id: message.id }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeChatCursor(value: string): ChatCursor | null {
  if (value.length > 300 || !/^[\w-]+$/.test(value)) return null
  try {
    const cursor = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof cursor.created_at !== 'string' || !TIMESTAMP.test(cursor.created_at) || !Number.isFinite(Date.parse(cursor.created_at))) return null
    if (typeof cursor.id !== 'string' || !UUID.test(cursor.id)) return null
    return { created_at: cursor.created_at, id: cursor.id.toLowerCase() }
  } catch {
    return null
  }
}

// PostgreSQL timestamps retain microseconds, which Date alone truncates. The ID
// breaks timestamp ties in the same order as the server's keyset pagination.
export function compareChatMessages(a: ChatCursor, b: ChatCursor): number {
  const milliseconds = Date.parse(a.created_at) - Date.parse(b.created_at)
  if (milliseconds) return milliseconds
  const fraction = (value: string) => (value.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0')
  const aFraction = fraction(a.created_at)
  const bFraction = fraction(b.created_at)
  if (aFraction !== bFraction) return aFraction < bFraction ? -1 : 1
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
}
