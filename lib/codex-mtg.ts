import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { dataFailure } from '@/lib/data-api-http'

export { CODEX_MTG_GROUP_ID, OWNER_PC_NAME, CODEX_MTG_BOT_USER_ID, isCodexMtgGroup } from '@/lib/codex-mtg-policy'

const id = z.string().uuid()
const content = z.string().trim().min(1).max(10000).refine(value => !value.includes('\0'))
const lease = { jobId: id, leaseToken: id }
export const codexMtgMachineSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('post'), sourceKey: z.string().min(1).max(128)
    .regex(/^[A-Za-z0-9:_-]+$/).refine(value => !value.startsWith('job-complete:')),
  content, kind: z.enum(['report', 'request']) }).strict(),
  z.object({ action: z.literal('claim') }).strict(),
  z.object({ action: z.literal('machineHeartbeat') }).strict(),
  z.object({ action: z.literal('peerClaim') }).strict(),
  z.object({ action: z.literal('peerHeartbeat'), ...lease }).strict(),
  z.object({ action: z.literal('peerComplete'), ...lease,
    decision: z.enum(['silent', 'report', 'question', 'needs_operator']), summary: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('heartbeat'), ...lease }).strict(),
  z.object({ action: z.literal('complete'), ...lease,
    status: z.enum(['completed', 'needs_operator', 'failed']), summary: content }).strict(),
])
export const codexMtgAdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), pcName: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }).strict(),
  z.object({ action: z.literal('revoke'), machineId: id }).strict(),
])

export function codexMtgTokenHash(request: Request): string | null {
  const token = request.headers.get('authorization')?.match(/^Bearer (tsg_mtg_[A-Za-z0-9_-]{43})$/)?.[1]
  return token ? createHash('sha256').update(token).digest('hex') : null
}

export function codexMtgResponse(result: unknown, requestId: string, extra: Record<string, unknown> = {}, status = 200) {
  if (!result || typeof result !== 'object' || !('ok' in result)) return dataFailure('INTERNAL', requestId)
  if (result.ok !== true) {
    const code = 'code' in result && typeof result.code === 'string' ? result.code : 'INTERNAL'
    return dataFailure(code, requestId)
  }
  const data = 'data' in result && result.data && typeof result.data === 'object' ? result.data : {}
  return NextResponse.json({ ok: true, ...data, ...extra, requestId }, {
    status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' },
  })
}
