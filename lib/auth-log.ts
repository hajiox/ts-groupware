import crypto from 'crypto'
import { adminClient } from '@/lib/supabase/admin'

export function getAuthFlowId(state: string | null) {
  if (!state) return null
  return crypto.createHash('sha256').update(state).digest('hex').slice(0, 16)
}

export async function logAuthEvent(params: {
  event: string
  flowId?: string | null
  detail?: string
  request?: Request
}) {
  try {
    await adminClient
      .from('gw_auth_logs')
      .insert({
        event: params.event,
        flow_id: params.flowId || null,
        detail: params.detail || null,
        user_agent: params.request?.headers.get('user-agent')?.slice(0, 300) || null,
        referer: params.request?.headers.get('referer')?.slice(0, 500) || null,
      })
  } catch (err) {
    console.error('[Auth log] Failed:', err)
  }
}
