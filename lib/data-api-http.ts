import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

const statusByCode: Record<string, number> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 400, NOT_FOUND: 404,
  CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, CONFIRMATION_REQUIRED: 409, RATE_LIMITED: 429,
}
const messages: Record<string, string> = {
  UNAUTHORIZED: '接続キーが無効、期限切れ、または失効済みです',
  FORBIDDEN: 'この操作または対象データは許可されていません',
  VALIDATION: '入力項目または値が不正です', NOT_FOUND: '対象が見つかりません',
  CONFLICT: 'データが変更されています。最新のversionを取得してください',
  IDEMPOTENCY_CONFLICT: '同じ冪等キーを別の内容に使用できません',
  CONFIRMATION_REQUIRED: '管理画面で差分を確認・承認してから確定してください',
  RATE_LIMITED: '接続の件数上限に達しました。時間を置いてください',
  INTERNAL: '処理に失敗しました。requestIdを管理者へお伝えください',
}
export function dataRequestId() { return randomUUID() }
export function dataSuccess(data: unknown, requestId: string, status = 200) {
  return NextResponse.json({ ok: true, data, requestId }, { status, headers: { 'Cache-Control': 'no-store' } })
}
export function dataFailure(code: string, requestId: string) {
  const safeCode = Object.hasOwn(statusByCode, code) ? code : 'INTERNAL'
  return NextResponse.json({ ok: false, error: { code: safeCode, message: messages[safeCode] }, requestId }, {
    status: statusByCode[safeCode] || 500, headers: { 'Cache-Control': 'no-store' },
  })
}
export function dataRpcFailure(error: unknown, requestId: string, operation: string) {
  const code = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'INTERNAL'
  const safeCode = Object.hasOwn(statusByCode, code) ? code : 'INTERNAL'
  console.warn('[data-api]', { requestId, operation, code: safeCode })
  return dataFailure(safeCode, requestId)
}
export async function readDataBody(request: Request) {
  const length = Number(request.headers.get('content-length') || 0)
  if (length > 32768) throw new Error('VALIDATION')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('VALIDATION')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 32768) {
        await reader.cancel()
        throw new Error('VALIDATION')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown } catch { throw new Error('VALIDATION') }
}
