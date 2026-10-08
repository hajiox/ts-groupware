import { NextRequest } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { CODEX_MTG_BOT_USER_ID, CODEX_MTG_GROUP_ID, codexMtgMachineSchema, codexMtgResponse, codexMtgTokenHash } from '@/lib/codex-mtg'
import { dataFailure, dataRequestId, dataRpcFailure, readDataBody } from '@/lib/data-api-http'
import { sendPushNotificationToGroup, sendPushNotificationToUser } from '@/lib/web-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = dataRequestId()
  const hash = codexMtgTokenHash(request)
  if (!hash) return dataFailure('UNAUTHORIZED', requestId)
  if (request.nextUrl.search) return dataFailure('VALIDATION', requestId)
  try {
    const { data, error } = await adminClient.rpc('gw_codex_mtg_machine', {
      p_token_hash: hash, p_action: 'snapshot', p_args: {},
    })
    if (error) return dataRpcFailure(error, requestId, 'codex_mtg_snapshot')
    return codexMtgResponse(data, requestId, {
      realtime: { url: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', topic: 'codex-mtg-v1' },
    })
  } catch (error) { return dataRpcFailure(error, requestId, 'codex_mtg_snapshot') }
}

export async function POST(request: NextRequest) {
  const requestId = dataRequestId()
  const hash = codexMtgTokenHash(request)
  if (!hash) return dataFailure('UNAUTHORIZED', requestId)
  try {
    const parsed = codexMtgMachineSchema.safeParse(await readDataBody(request))
    if (!parsed.success) return dataFailure('VALIDATION', requestId)
    const { action, ...args } = parsed.data
    const { data, error } = await adminClient.rpc(action.startsWith('peer') ? 'gw_codex_mtg_peer' : 'gw_codex_mtg_machine', {
      p_token_hash: hash, p_action: action, p_args: args,
    })
    if (error) return dataRpcFailure(error, requestId, `codex_mtg_${action}`)
    if ((action === 'post' || action === 'complete' || action === 'peerComplete') && data?.ok === true
      && data.data?.duplicate === false && typeof data.data.postId === 'string') {
      try {
        const { data: post, error: postError } = await adminClient.from('gw_posts')
          .select('id,content').eq('id', data.data.postId).eq('group_id', CODEX_MTG_GROUP_ID)
          .eq('user_id', CODEX_MTG_BOT_USER_ID).maybeSingle()
        if (postError) throw new Error('Stored CodexMTG notification post could not be read')
        if (post) await sendPushNotificationToGroup(CODEX_MTG_GROUP_ID, CODEX_MTG_BOT_USER_ID, {
          title: 'CodexMTG - TSG君', body: (post.content || '').substring(0, 80),
          url: `/chat/${CODEX_MTG_GROUP_ID}`, tag: `codex-mtg-${post.id}`,
        }, post.id)
      } catch {
        // The transaction has committed: notification failure must not retry the post.
        console.warn('[codex-mtg] Push notification could not be delivered', { requestId })
      }
      if (parsed.data.action === 'complete' && parsed.data.status === 'completed') {
        try {
          const { data: job, error: jobError } = await adminClient.from('gw_codex_mtg_jobs')
            .select('author_id,result_dm_post_id').eq('id', parsed.data.jobId)
            .eq('result_post_id', data.data.postId).eq('origin', 'human').eq('status', 'completed').maybeSingle()
          if (jobError) throw new Error('Stored completion DM receipt could not be read')
          if (job?.author_id && job.result_dm_post_id) {
            const { data: dm, error: dmError } = await adminClient.from('gw_posts')
              .select('id,group_id,content').eq('id', job.result_dm_post_id)
              .eq('user_id', CODEX_MTG_BOT_USER_ID).maybeSingle()
            if (dmError || !dm) throw new Error('Stored completion DM could not be read')
            await sendPushNotificationToUser(job.author_id, {
              title: '開発依頼の結果 - TSG君', body: (dm.content || '').substring(0, 80),
              url: `/chat/${dm.group_id}`, tag: `codex-mtg-dm-${dm.id}`,
            }, dm.id)
          }
        } catch {
          // Both posts are already saved even if an optional device push fails.
          console.warn('[codex-mtg] Completion DM push could not be delivered', { requestId })
        }
      }
    }
    return codexMtgResponse(data, requestId)
  } catch (error) { return dataRpcFailure(error, requestId, 'codex_mtg_machine') }
}
