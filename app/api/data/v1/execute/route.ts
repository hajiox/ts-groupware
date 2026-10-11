import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { businessExecuteSchema, dataExecuteSchema } from '@/lib/data-api-policy'
import { executeBusinessOperation } from '@/lib/business-api/gateway'
import { dataFailure, dataRequestId, dataRpcFailure, dataSuccess, readDataBody } from '@/lib/data-api-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  const requestId = dataRequestId()
  const token = request.headers.get('authorization')?.match(/^Bearer (tsg_data_[A-Za-z0-9_-]{40,128})$/)?.[1]
  if (!token) return dataFailure('UNAUTHORIZED', requestId)
  try {
    let rawBytes = 0
    const raw = await readDataBody(request, 3 * 1024 * 1024, bytes => { rawBytes = bytes })
    if (raw && typeof raw === 'object' && 'operation' in raw && typeof raw.operation === 'string' && raw.operation.startsWith('business.')) {
      const business = businessExecuteSchema.safeParse(raw)
      if (!business.success) return dataFailure('VALIDATION', requestId)
      return executeBusinessOperation(createHash('sha256').update(token).digest('hex'), business.data, requestId)
    }
    if (rawBytes > 32768 || Number(request.headers.get('content-length') || 0) > 32768) return dataFailure('VALIDATION', requestId)
    const parsed = dataExecuteSchema.safeParse(raw)
    if (!parsed.success) return dataFailure('VALIDATION', requestId)
    const body = parsed.data
    const { data, error } = await adminClient.rpc('gw_data_api_execute', {
      p_token_hash: createHash('sha256').update(token).digest('hex'),
      p_operation: body.operation, p_args: body.input,
      p_idempotency_key: body.idempotencyKey || null,
      p_expected_version: body.expectedVersion || null,
      p_confirmation_id: body.confirmationId || null, p_request_id: requestId,
    })
    if (error) return dataRpcFailure(error, requestId, body.operation)
    if (!data || data.ok !== true) return dataFailure('INTERNAL', requestId)
    return dataSuccess(data.data, requestId)
  } catch (error) { return dataRpcFailure(error, requestId, 'execute') }
}
