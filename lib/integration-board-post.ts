import { createHash } from 'node:crypto'

export function boardSelector(body: Record<string, unknown>) {
  const hasId = Object.hasOwn(body, 'boardId')
  const hasName = Object.hasOwn(body, 'boardName')
  if (hasId === hasName) throw new Error('board selector is invalid')
  if (hasId) {
    if (typeof body.boardId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.boardId)) {
      throw new Error('boardId is invalid')
    }
    return { boardId: body.boardId.toLowerCase() }
  }
  if (typeof body.boardName !== 'string' || !body.boardName.trim() || body.boardName.length > 200) {
    throw new Error('boardName is invalid')
  }
  // Exact names avoid guessing between similarly named boards.
  return { boardName: body.boardName }
}

export function boardPostInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body is invalid')
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some(key => !['sourceKey', 'boardId', 'boardName', 'content'].includes(key))) {
    throw new Error('body is invalid')
  }
  const { sourceKey, content } = body
  if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(sourceKey)) {
    throw new Error('sourceKey is invalid')
  }
  if (typeof content !== 'string' || !content.trim() || content.length > 10000 || content.includes('\0')) {
    throw new Error('content is invalid')
  }
  return { sourceKey, content, ...boardSelector(body) }
}

export function boardPostId(sourceKey: string) {
  // Destination is deliberately excluded: changing it on a retry must conflict.
  const bytes = createHash('sha256').update(`tsg_board_post:${sourceKey}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
