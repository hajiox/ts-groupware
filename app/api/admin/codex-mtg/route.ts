import { createHash, randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { isManagementRole } from '@/lib/user-roles'
import { codexMtgAdminSchema, codexMtgResponse } from '@/lib/codex-mtg'
import { dataFailure, dataRequestId, dataRpcFailure, readDataBody } from '@/lib/data-api-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const requestId = dataRequestId()
  try {
    const user = await getUserSession()
    if (!user) return dataFailure('UNAUTHORIZED', requestId)
    if (user.status !== 'approved' || !isManagementRole(user.role)) return dataFailure('FORBIDDEN', requestId)
    const { data, error } = await adminClient.rpc('gw_codex_mtg_admin', {
      p_actor_id: user.id, p_action: 'status', p_args: {},
    })
    if (error) return dataRpcFailure(error, requestId, 'codex_mtg_admin_status')
    return codexMtgResponse(data, requestId)
  } catch (error) { return dataRpcFailure(error, requestId, 'codex_mtg_admin_status') }
}

export async function POST(request: NextRequest) {
  const requestId = dataRequestId()
  try {
    const user = await getUserSession()
    if (!user) return dataFailure('UNAUTHORIZED', requestId)
    if (user.status !== 'approved' || user.role !== 'executive') return dataFailure('FORBIDDEN', requestId)
    if (request.headers.get('origin') !== request.nextUrl.origin) return dataFailure('FORBIDDEN', requestId)
    const parsed = codexMtgAdminSchema.safeParse(await readDataBody(request))
    if (!parsed.success) return dataFailure('VALIDATION', requestId)
    const body = parsed.data
    const token = body.action === 'register' ? `tsg_mtg_${randomBytes(32).toString('base64url')}` : undefined
    const args = body.action === 'register'
      ? { pcName: body.pcName, tokenHash: createHash('sha256').update(token!).digest('hex') }
      : { machineId: body.machineId }
    const { data, error } = await adminClient.rpc('gw_codex_mtg_admin', {
      p_actor_id: user.id, p_action: body.action, p_args: args,
    })
    if (error) return dataRpcFailure(error, requestId, `codex_mtg_admin_${body.action}`)
    return codexMtgResponse(data, requestId, token ? { token } : {}, token ? 201 : 200)
  } catch (error) { return dataRpcFailure(error, requestId, 'codex_mtg_admin') }
}
