import assert from 'node:assert/strict'
import { appendMentionIfMissing } from '../lib/mention-names.ts'

assert.equal(appendMentionIfMissing('', '藤田 香織'), '@藤田 香織さん ')
assert.equal(
  appendMentionIfMissing('確認をお願いします', '藤田 香織'),
  '確認をお願いします @藤田 香織さん ',
)
assert.equal(
  appendMentionIfMissing('確認をお願いします\n', '藤田 香織'),
  '確認をお願いします\n@藤田 香織さん ',
)
assert.equal(
  appendMentionIfMissing('確認をお願いします @藤田 香織さん ', '藤田 香織'),
  '確認をお願いします @藤田 香織さん ',
)
assert.equal(
  appendMentionIfMissing('@藤田香織 確認をお願いします', '藤田 香織'),
  '@藤田香織 確認をお願いします',
)
assert.equal(appendMentionIfMissing('確認をお願いします', '佐藤 正彦'), '確認をお願いします @社長 ')
assert.equal(appendMentionIfMissing('@佐藤正彦 確認をお願いします', '佐藤 正彦'), '@佐藤正彦 確認をお願いします')

console.log('task assignee mention tests passed')
