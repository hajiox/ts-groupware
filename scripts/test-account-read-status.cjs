const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
}

const unread = source('lib/unread.ts')
const readStatus = source('lib/read-status.ts')

assert.match(unread, /\.from\('gw_read_status'\)/)
assert.doesNotMatch(unread, /gw_device_read_status|deviceId/)
assert.match(readStatus, /markGroupRead\(userId: string, groupId: string\)/)
assert.doesNotMatch(readStatus, /gw_device_read_status|seedDeviceReadStatus/)

for (const route of [
  'app/api/unread/route.ts',
  'app/api/groups/route.ts',
  'app/api/dm/unread/route.ts',
  'app/api/posts/route.ts',
  'app/api/chat/route.ts',
]) {
  assert.doesNotMatch(source(route), /getDeviceIdFromRequest/)
}

assert.doesNotMatch(source('lib/web-push.ts'), /getUnreadSummary\(sub\.user_id,/)
assert.match(source('app/api/push/subscribe/route.ts'), /getDeviceIdFromRequest/)

console.log('TSG account-scoped read status checks passed.')
