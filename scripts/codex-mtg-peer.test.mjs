import test from 'node:test'
import assert from 'node:assert/strict'
import { PeerWorker, validatePeerResult, validatePeerCompletion } from './codex-mtg-peer.mjs'
import { GROUP_ID } from './codex-mtg-worker.mjs'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const postId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const config = { pcName: 'CEO_S', token: `tsg_mtg_${'a'.repeat(43)}` }
const job = { id, postId, origin: 'human', allowCodeChange: false, content: 'CEO_Sに確認', requesterName: '管理者', leaseToken: id, mayReply: true }
const info = { ok: true, machine: { id, pcName: 'CEO_S', canExecuteCode: false }, group: { id: GROUP_ID }, posts: [], realtime: { url: 'https://example.supabase.co', anonKey: 'public', topic: 'codex-mtg-v1' } }
function fixture(options = {}) {
  const calls = []; const saves = []; const states = []; let delivered = false; let runCount = 0; let completeCount = 0
  const worker = new PeerWorker(config, {
    api: async (action, body) => {
      calls.push({ action, body })
      if (!action) return info
      if (action === 'peerClaim') { if (delivered) return { ok: true, job: null }; delivered = true; return { ok: true, job: { ...job, ...options.job } } }
      if (action === 'peerHeartbeat') { if (options.leaseError) throw new Error('NETWORK'); return { ok: true, leaseExpiresAt: new Date(Date.now() + 180000).toISOString() } }
      if (action === 'peerComplete') {
        completeCount++
        if (options.completeError && completeCount === 1) throw new Error('NETWORK')
        return { ok: true, jobId: body.jobId, decision: body.decision, duplicate: completeCount > 1, postId: body.decision === 'silent' ? null : postId }
      }
      throw new Error('Unexpected action')
    },
    run: async () => { runCount++; if (options.runError) throw new Error('CLI'); return options.result || { decision: 'report', summary: '提供された情報を確認しました' } },
    save: value => saves.push(value), monitor: state => { states.push({ ...state }); if (options.monitorError) throw new Error('UI_CLOSED') },
  })
  return { worker, calls, saves, states, runs: () => runCount }
}
test('concurrent wake serializes one analysis and exactly one reply', async () => {
  const f = fixture(); await Promise.all([f.worker.wake(), f.worker.wake(), f.worker.wake()])
  assert.equal(f.runs(), 1); assert.equal(f.calls.filter(c => c.action === 'peerComplete').length, 1)
  assert.equal(f.worker.state.status, 'idle')
  const monitor = JSON.stringify(f.states); assert.ok(!monitor.includes(config.token)); assert.ok(!monitor.includes(job.content)); assert.ok(!monitor.includes('leaseToken'))
})
test('informational auto responses are acknowledged without AI or another post', async () => {
  const f = fixture({ job: { mayReply: false } }); await f.worker.wake()
  assert.equal(f.runs(), 0); assert.equal(f.calls.find(c => c.action === 'peerComplete').body.decision, 'silent')
})
test('uncertain publication retries only identical completion, never AI', async () => {
  const f = fixture({ completeError: true }); await f.worker.wake(); assert.equal(f.worker.saved.phase, 'completion_pending')
  await f.worker.wake(); const complete = f.calls.filter(c => c.action === 'peerComplete')
  assert.equal(f.runs(), 1); assert.deepEqual(complete[0].body, complete[1].body); assert.equal(f.worker.saved, null)
})
test('lost lease stops analysis/publication and preserves durable server work', async () => {
  const f = fixture({ leaseError: true }); await f.worker.wake()
  assert.equal(f.runs(), 0); assert.equal(f.calls.some(c => c.action === 'peerComplete'), false)
})
test('CLI failure produces one operator-needed result instead of repeated AI', async () => {
  const f = fixture({ runError: true }); await f.worker.wake(); await f.worker.wake()
  assert.equal(f.runs(), 1); assert.equal(f.calls.find(c => c.action === 'peerComplete').body.decision, 'needs_operator')
})
test('monitor closure does not stop worker and result data cannot contain token or unexpected keys', async () => {
  const f = fixture({ monitorError: true }); await f.worker.wake(); assert.equal(f.runs(), 1)
  assert.throws(() => validatePeerResult({ decision: 'report', summary: config.token }, config, job))
  assert.throws(() => validatePeerResult({ decision: 'report', summary: 'test', permission: true }, config, job))
  assert.throws(() => validatePeerResult({ decision: 'report', summary: 'test' }, config, { ...job, mayReply: false }))
  assert.throws(() => validatePeerCompletion({ ok: true, jobId: id, decision: 'silent', duplicate: false, postId }, { jobId: id, decision: 'silent' }))
})
test('machine mismatch and revoked authentication never claim or run AI', async () => {
  const calls = []; const worker = new PeerWorker(config, { api: async a => { calls.push(a); throw new Error('MACHINE_UNAUTHORIZED') }, monitor: () => {} })
  await worker.wake(); await worker.wake(); assert.equal(worker.stopped, true); assert.equal(calls.length, 1)
  const f = fixture(); f.worker.config = { ...config, pcName: 'CEO-DOUGA' }; await f.worker.wake()
  assert.equal(f.runs(), 0); assert.equal(f.calls.some(c => c.action === 'peerClaim'), false)
})
