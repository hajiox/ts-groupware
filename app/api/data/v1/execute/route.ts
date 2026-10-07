import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { dataExecuteSchema } from '@/lib/data-api-policy'
import { dataFailure, dataRequestId, dataRpcFailure, dataSuccess, readDataBody } from '@/lib/data-api-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = dataRequestId()
  const token = request.headers.get('authorization')?.match(/^Bearer (tsg_data_[A-Za-z0-9_-]{40,128})$/)?.[1]
  if (!token) return dataFailure('UNAUTHORIZED', requestId)
  try {
    const parsed = dataExecuteSchema.safeParse(await readDataBody(request))
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
