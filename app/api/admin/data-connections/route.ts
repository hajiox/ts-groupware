import { createHash, randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { dataAdminSchema } from '@/lib/data-api-policy'
import { dataFailure, dataRequestId, dataRpcFailure, dataSuccess, readDataBody } from '@/lib/data-api-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = dataRequestId()
  const view = request.nextUrl.searchParams.get('view') || 'list'
  try {
    const user = await getUserSession()
    if (!user) return dataFailure('UNAUTHORIZED', requestId)
    if (user.role !== 'executive') return dataFailure('FORBIDDEN', requestId)
    if (!['list', 'list_confirmations', 'list_audit'].includes(view)) return dataFailure('VALIDATION', requestId)
    const { data, error } = await adminClient.rpc('gw_data_connection_admin', {
      p_actor_id: user.id, p_action: view, p_args: {},
    })
    if (error) return dataRpcFailure(error, requestId, view)
    if (!data || data.ok !== true) return dataFailure('INTERNAL', requestId)
    return dataSuccess(data.data, requestId)
  } catch (error) { return dataRpcFailure(error, requestId, 'admin_read') }
}

export async function POST(request: NextRequest) {
  const requestId = dataRequestId()
  try {
    const user = await getUserSession()
    if (!user) return dataFailure('UNAUTHORIZED', requestId)
    if (user.role !== 'executive') return dataFailure('FORBIDDEN', requestId)
    if (request.headers.get('origin') !== request.nextUrl.origin) return dataFailure('FORBIDDEN', requestId)
    const parsed = dataAdminSchema.safeParse(await readDataBody(request))
    if (!parsed.success) return dataFailure('VALIDATION', requestId)
    const body = parsed.data
    let token: string | undefined
    let args: Record<string, unknown>
    if (body.action === 'create') {
      const expires = Date.parse(body.expiresAt)
      if (expires <= Date.now() || expires > Date.now() + 90 * 86400000) return dataFailure('VALIDATION', requestId)
      token = `tsg_data_${randomBytes(32).toString('base64url')}`
      args = { label: body.label, token_hash: createHash('sha256').update(token).digest('hex'),
        principal_user_id: user.id, scopes: [...new Set(body.scopes)],
        allowed_group_ids: [...new Set(body.allowedGroupIds)], expires_at: body.expiresAt, max_limit: body.maxLimit }
    } else {
      args = { id: body.id, ...(body.action === 'approve_confirmation' ? { digest: body.digest } : {}) }
    }
    const { data, error } = await adminClient.rpc('gw_data_connection_admin', {
      p_actor_id: user.id, p_action: body.action, p_args: args,
    })
    if (error) return dataRpcFailure(error, requestId, body.action)
    if (!data || data.ok !== true) return dataFailure('INTERNAL', requestId)
    // Raw credentials are returned once, only to this authenticated human flow.
    return dataSuccess({ ...data.data, ...(token ? { token } : {}) }, requestId, body.action === 'create' ? 201 : 200)
  } catch (error) { return dataRpcFailure(error, requestId, 'admin') }
}
