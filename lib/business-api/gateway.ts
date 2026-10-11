import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { dataFailure, dataRpcFailure, dataSuccess } from '@/lib/data-api-http'
import { normalizeLinePictureUrl } from '@/lib/line-picture'
import { getBusinessOperation, listBusinessOperations } from '@/lib/business-api/catalog'
import { dispatchBusinessOperation, type BusinessOperationInput, type BusinessDispatchResult } from '@/lib/business-api/dispatch'
import { runWithBusinessContext, type BusinessUser } from '@/lib/business-api/context'

type BusinessEnvelope = {
  operation: 'business.operations' | 'business.read' | 'business.write'
  input: BusinessOperationInput & { area?: string; operationId?: string }
  idempotencyKey?: string
}

const privateKeys = /^(?:authorization|cookie|set-cookie|token|token_hash|access_token|refresh_token|api_key|secret|service_role_key|private_key)$/i
const secretToken = /\btsg_(?:data|mtg)_[A-Za-z0-9_-]{32,248}\b/g

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('INVALID_RESPONSE')
  if (typeof value === 'string') return value.replace(secretToken, '[redacted]')
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateKeys.test(key) ? '[redacted]' : sanitize(item, depth + 1)]))
  return value
}

// Sorting object keys keeps retries stable even if a client serializes the same
// JSON object in a different order. Arrays, file bytes, and locked values remain.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

function responseFor(result: BusinessDispatchResult, requestId: string): NextResponse {
  if (result.status >= 200 && result.status < 300) return dataSuccess(result, requestId, result.status === 204 ? 200 : result.status)
  const codes: Record<number, string> = { 400: 'VALIDATION', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'VALIDATION', 429: 'RATE_LIMITED' }
  const code = codes[result.status] || 'INTERNAL'
  const body = 'body' in result && result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
  const message = result.status < 500 && typeof body?.error === 'string' ? body.error.slice(0, 1000) : '処理に失敗しました。requestIdを管理者へお伝えください'
  return NextResponse.json({ ok: false, error: { code, message }, requestId }, { status: result.status >= 400 && result.status <= 599 ? result.status : 500, headers: { 'Cache-Control': 'no-store' } })
}

function pendingResponse(requestId: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code: 'WRITE_PENDING', message: '前回の処理結果が未確定です。重複実行を止めています。同じ冪等キーで結果を確認し、対象の保存状況も確認してください。' }, requestId }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
}

export async function executeBusinessOperation(tokenHash: string, body: BusinessEnvelope, requestId: string): Promise<NextResponse> {
  let reserved = false
  try {
    const operationId = body.input.operationId
    const { data: auth, error: authError } = await adminClient.rpc('gw_business_api_authenticate', {
      p_token_hash: tokenHash, p_operation_id: operationId || body.operation, p_request_id: requestId,
    })
    if (authError) return dataRpcFailure(authError, requestId, body.operation)
    if (!auth?.connectionId || !auth.principalUserId || !auth.pcName) return dataFailure('UNAUTHORIZED', requestId)
    // Reload the actual principal on every invocation. No caller-selected user,
    // role, unsigned cookie, or synthetic session enters a business handler.
    const { data: user, error: userError } = await adminClient.from('gw_users').select('*').eq('id', auth.principalUserId).single()
    if (userError || !user || user.status !== 'approved' || user.role !== 'executive') return dataFailure('UNAUTHORIZED', requestId)
    user.display_name = user.real_name || user.display_name
    user.picture_url = normalizeLinePictureUrl(user.picture_url)
    if (body.operation === 'business.operations') {
      const operations = listBusinessOperations().filter(item => (!body.input.area || item.area === body.input.area) && (!operationId || item.id === operationId))
      return dataSuccess({ operations }, requestId)
    }
    const operation = operationId ? getBusinessOperation(operationId) : undefined
    if (!operation || (body.operation === 'business.read') !== operation.readOnly) return dataFailure('VALIDATION', requestId)
    const { area: _area, operationId: _operationId, ...input } = body.input
    void _area; void _operationId
    const requestHash = createHash('sha256').update(canonical({ operationId, input })).digest('hex')
    if (!operation.readOnly) {
      const { data: started, error: beginError } = await adminClient.rpc('gw_business_api_begin', {
        p_token_hash: tokenHash, p_operation_id: operation.id, p_request_hash: requestHash,
        p_idempotency_key: body.idempotencyKey || null, p_request_id: requestId,
      })
      if (beginError) return dataRpcFailure(beginError, requestId, body.operation)
      if (started?.state === 'completed') return responseFor({ status: started.status, ...started.response } as BusinessDispatchResult, requestId)
      if (started?.state !== 'started') return pendingResponse(requestId)
      reserved = true
    } else if (body.idempotencyKey) return dataFailure('VALIDATION', requestId)

    const result = sanitize(await runWithBusinessContext({ connectionId: auth.connectionId, pcName: auth.pcName, user: user as BusinessUser }, () => dispatchBusinessOperation(operation.id, input))) as BusinessDispatchResult
    if (!result || typeof result.status !== 'number') throw new Error('INVALID_RESPONSE')
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 10 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE')
    if (reserved) {
      // Errors below 500 are cached as well: even a validation response can
      // follow a handler's partial side effect. A retry must never rerun it.
      if (result.status < 200 || result.status >= 500) return pendingResponse(requestId)
      const { status, ...response } = result
      const { error: finishError, data: finished } = await adminClient.rpc('gw_business_api_finish', {
        p_token_hash: tokenHash, p_request_id: requestId, p_request_hash: requestHash,
        p_response: response, p_status: status,
      })
      if (finishError || finished !== true) return pendingResponse(requestId)
    }
    return responseFor(result, requestId)
  } catch (error) {
    // Never clear a durable write reservation after a timeout, a handler error,
    // or an uncertain response. The original mutation may already have worked.
    if (reserved) return pendingResponse(requestId)
    return dataRpcFailure(error, requestId, body.operation)
  }
}
