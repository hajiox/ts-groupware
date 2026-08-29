const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meeting-transcriber-summary.ts'), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require)

assert.equal(loaded.exports.normalizeManagementBoardName(' ＴＳ （ 管理職 ） '), 'ts(管理職)')
assert.equal(loaded.exports.normalizeManagementBoardName('TS(管理職)'), 'ts(管理職)')
assert.equal(loaded.exports.requiredMeetingSummaryText('  議事録  ', 'content', 100), '議事録')
assert.throws(() => loaded.exports.requiredMeetingSummaryText('', 'content', 100), /content is invalid/)
assert.throws(() => loaded.exports.requiredMeetingSummaryText('1234', 'content', 3), /content is invalid/)

const firstId = loaded.exports.meetingTranscriberSummaryPostId('meeting:recording-123:summary')
assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.equal(loaded.exports.meetingTranscriberSummaryPostId('meeting:recording-123:summary'), firstId)
assert.notEqual(loaded.exports.meetingTranscriberSummaryPostId('meeting:recording-124:summary'), firstId)

const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'api', 'integrations', 'meeting-transcriber', 'summary', 'route.ts'),
  'utf8',
)
assert.match(routeSource, /MEETING_TRANSCRIBER_INTEGRATION_SECRET/)
assert.doesNotMatch(routeSource, /process\.env\.TSG_INTEGRATION_SECRET/)
assert.match(routeSource, /const MANAGEMENT_BOARD_NAME = 'TS（管理職）'/)
assert.match(routeSource, /getTsgUserId\(\)/)
assert.match(routeSource, /Integration message identity conflict/)
assert.match(routeSource, /sendPushNotificationToGroup/)
assert.doesNotMatch(routeSource, /body\.(groupId|groupName|userId|posterId)/)
assert.doesNotMatch(routeSource, /export async function (GET|PATCH|DELETE)/)

console.log('TSG MeetingTranscriber summary integration checks passed.')
