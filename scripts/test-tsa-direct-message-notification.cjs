const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tsa-direct-message.ts'), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require)

assert.equal(loaded.exports.normalizeDirectMessageUserName(' 藤田　香織 '), '藤田香織')
assert.equal(
  loaded.exports.directChatKey('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'direct:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
)

const firstId = loaded.exports.tsaDirectMessagePostId('ingredient-label:2026-08-27', 'recipient-id')
assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.equal(loaded.exports.tsaDirectMessagePostId('ingredient-label:2026-08-27', 'recipient-id'), firstId)
assert.notEqual(loaded.exports.tsaDirectMessagePostId('ingredient-label:2026-08-27', 'another-recipient'), firstId)
assert.equal(loaded.exports.requiredDirectMessageText('  完了しました。  ', 'content', 100), '完了しました。')
assert.throws(() => loaded.exports.requiredDirectMessageText('', 'content', 100), /content is invalid/)

const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'api', 'integrations', 'tsa', 'direct-message', 'route.ts'),
  'utf8',
)
assert.match(routeSource, /TSG_INTEGRATION_SECRET/)
assert.match(routeSource, /recipientName must identify exactly one approved user/)
assert.match(routeSource, /Direct-message group member verification failed/)
assert.match(routeSource, /sendPushNotificationToUser/)

console.log('TSG TSA direct-message integration checks passed.')
