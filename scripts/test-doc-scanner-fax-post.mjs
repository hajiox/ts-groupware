import assert from 'node:assert/strict'
import {
  buildFaxReceivedPostContent,
  preserveResolvedFaxSummary,
  updateFaxSummaryInContent,
} from '../lib/doc-scanner-fax-post.ts'

const pending = buildFaxReceivedPostContent({
  sourceKey: 'message-1:hash-1',
  senderLabel: '0242-00-0000',
  subject: 'eFax message',
  receivedAt: '2026-08-27T00:00:00.000Z',
  imageCount: 2,
  summaryStatus: 'pending',
})

assert.match(pending, /FAX画像: 2枚添付/)
assert.match(pending, /【AI要約】\n要約を作成中です。FAX画像は先に確認できます。/)
assert.match(pending, /受信ID: message-1:hash-1$/)

const completed = updateFaxSummaryInContent(
  pending,
  'completed',
  '書類種別: 発注書\n概要: 商品3点の発注です。\n対応: 納期を確認してください。',
)
assert.doesNotMatch(completed, /要約を作成中/)
assert.equal((completed.match(/【AI要約】/g) || []).length, 1)
assert.match(completed, /概要: 商品3点の発注です。/)

const duplicatePending = buildFaxReceivedPostContent({
  sourceKey: 'message-1:hash-1',
  senderLabel: '0242-00-0000',
  subject: 'eFax message',
  receivedAt: '2026-08-27T00:00:00.000Z',
  imageCount: 2,
})
const preserved = preserveResolvedFaxSummary(completed, duplicatePending)
assert.match(preserved, /概要: 商品3点の発注です。/)
assert.doesNotMatch(preserved, /要約を作成中/)

const failed = updateFaxSummaryInContent(pending, 'failed')
assert.match(failed, /要約を作成できませんでした。FAX画像を確認してください。/)

console.log('DocScanner FAX post summary formatting verified.')
