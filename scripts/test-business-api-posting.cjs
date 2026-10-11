const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// The real handlers run against synthetic storage only. No cookies, credentials,
// Google client, Supabase connection or notification endpoint is loaded.
const principal = { id: 'test-principal', role: 'executive', status: 'approved', display_name: '試験管理者' }
const botId = 'f78baef5-d40c-4886-b51d-a02efbf794fe'
const groupId = 'test-group'
const context = { connectionId: 'test-connection', pcName: 'CEO_S', user: principal }
let activeContext = context
let member = true
let ownerReadError = false
let uploadTrackError = false
let groupType = 'board'
let direct = false
let existing
let writes = []
let reads = []
let driveDeletes = []
let uploads = []
let pushes = []
let aiCalls = 0
const ownedIds = new Set(['owned_file'])
const attachment = id => ({ driveId: id, name: 'test.png', type: 'image/png',
  url: `https://drive.google.com/uc?export=download&id=${id}`,
  viewUrl: `https://drive.google.com/thumbnail?id=${id}&sz=w1200`,
  webViewLink: `https://drive.google.com/file/d/${id}/view` })

function query(table) {
  const filters = {}
  let mutation
  const chain = {
    select() { return chain }, eq(key, value) { filters[key] = value; return chain },
    neq(key, value) { filters[`not_${key}`] = value; return chain },
    in(key, value) { filters[key] = value; return chain }, is() { return chain }, order() { return chain },
    insert(value) { mutation = ['insert', value]; return chain },
    update(value) { mutation = ['update', value]; return chain },
    upsert(value) { mutation = ['upsert', value]; return chain },
    delete() { mutation = ['delete']; return chain },
    single() { return Promise.resolve(result()) }, maybeSingle() { return Promise.resolve(result()) },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
  }
  function result() {
    if (mutation) {
      writes.push({ table, mutation, filters: { ...filters } })
      if (table === 'gw_data_business_uploads' && uploadTrackError) return { data: null, error: { message: 'synthetic tracking failure' } }
      if (table === 'gw_posts') return { data: { ...existing, id: 'test-message', ...mutation[1] }, error: null }
      return { data: null, error: null }
    }
    reads.push({ table, filters: { ...filters } })
    if (table === 'gw_data_business_uploads') return { data: [...ownedIds].map(drive_id => ({ drive_id })), error: ownerReadError ? { message: 'synthetic owner read failure' } : null }
    if (table === 'gw_group_members') {
      if (filters.user_id) {
        assert.equal(filters.user_id, principal.id, 'Authorization must use the verified principal, not TSG君')
        return { data: member ? { user_id: principal.id, role: 'member' } : null, error: null }
      }
      return { data: [], error: null }
    }
    if (table === 'gw_groups') return { data: { id: groupId, type: groupType, name: 'Synthetic',
      description: direct ? `direct:${principal.id}:other-user` : '', posting_disabled: false }, error: null }
    if (table === 'gw_posts') return { data: filters.parent_id ? [] : existing, error: null }
    if (table === 'gw_tasks') return { data: [], error: null }
    throw new Error(`Unexpected table ${table}`)
  }
  return chain
}

class FakeNextResponse extends Response {
  static json(value, init) { return new FakeNextResponse(JSON.stringify(value), init) }
}
const dependencies = {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/business-api/context': { getBusinessContext: () => activeContext },
  '@/lib/session': { getUserSession: async () => principal },
  '@/lib/drive': {
    deleteFileFromDrive: async id => { driveDeletes.push(id) },
    uploadFileToDrive: async (buffer, name, type) => { uploads.push({ bytes: buffer.length, name, type }); return { id: 'uploaded_file', webViewLink: 'https://drive.google.com/file/d/uploaded_file/view' } },
  },
  '@/lib/read-status': { markGroupRead: async () => ({ error: null }) },
  '@/lib/mention-names': { normalizeMentionContent: value => value },
  '@/lib/user-roles': { isManagementUser: user => ['executive', 'admin'].includes(user?.role), isManagementRole: role => ['executive', 'admin'].includes(role) },
  '@/lib/codex-mtg-policy': { CODEX_MTG_BOT_USER_ID: botId, isCodexMtgGroup: id => id === 'immutable-codex-mtg' },
  '@/lib/web-push': { sendPushNotificationToUser: async (...args) => { pushes.push(args[1]) }, sendPushNotificationToGroup: async (...args) => { pushes.push(args[2]) } },
  '@/lib/mentions': { findMentionedUsersInGroup: async () => [], sendMentionNotifications: async () => {} },
  '@/lib/tsg-ai': { isTsgDirectChat: async () => true, handleTsgAiResponse: async () => { aiCalls++ } },
}
function load(relativePath) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unmocked import ${name}`)
    return dependencies[name]
  })
  return loaded.exports
}
dependencies['@/lib/business-api/posting'] = load('lib/business-api/posting.ts')
const posting = dependencies['@/lib/business-api/posting']
const posts = load('app/api/posts/route.ts')
const chat = load('app/api/chat/route.ts')
const upload = load('app/api/upload/route.ts')
const request = (body = {}, search = '') => ({ json: async () => body,
  nextUrl: new URL(`https://tsg.example.invalid/api/test${search}`) })
function reset(type = 'board') {
  activeContext = context; member = true; ownerReadError = false; uploadTrackError = false
  writes = []; reads = []; driveDeletes = []; uploads = []; pushes = []; groupType = type; direct = false
  existing = { id: 'test-message', group_id: groupId, user_id: botId, content: '【PC: CEO_S】\n旧本文', attachments: [], parent_id: null }
}
const postWrites = () => writes.filter(write => write.table === 'gw_posts')

async function main() {
  reset()
  assert.equal(posting.businessPostContent('【PC: forged】\n本文'), '【PC: CEO_S】\n本文')
  assert.equal(posting.businessPostContent('【PC: CEO_S】\n本文'), '【PC: CEO_S】\n本文')
  assert.equal(posting.isOwnBusinessPost(existing), true)
  assert.equal(posting.isOwnBusinessPost({ ...existing, content: '【PC: TSA】\n本文' }), false)
  assert.equal(await posting.validateBusinessAttachments([attachment('owned_file')]), null)
  assert.equal(reads.at(-1).filters.connection_id, context.connectionId)
  assert.equal((await posting.validateBusinessAttachments([attachment('other_file')])).status, 403)
  for (const fields of [{ url: 'https://evil.example/file' }, { viewUrl: 'https://drive.google.com/thumbnail?id=other_file' }, { driveId: undefined }]) {
    assert.equal((await posting.validateBusinessAttachments([{ ...attachment('owned_file'), ...fields }])).status, 400)
  }
  const legacy = { url: 'https://legacy.example/old.png', name: '旧画像' }
  assert.equal(await posting.validateBusinessAttachments([legacy], [legacy]), null, 'Unchanged old references may be retained')
  assert.equal((await posting.validateBusinessAttachments([{ ...legacy, url: 'https://evil.example/replacement.png' }], [legacy])).status, 400)
  ownerReadError = true
  assert.equal((await posting.validateBusinessAttachments([attachment('owned_file')])).status, 500)

  for (const [api, type] of [[posts, 'board'], [chat, 'chat']]) {
    reset(type)
    const response = await api.POST(request({ group_id: groupId, content: '【PC: forged】\n送信本文', attachments: [attachment('owned_file')], user_id: 'forged-user', pcName: 'forged' }))
    assert.equal(response.status, 201)
    const row = postWrites()[0].mutation[1]
    assert.equal(row.user_id, botId)
    assert.equal(row.content, '【PC: CEO_S】\n送信本文')
    assert.equal(pushes.length, 1)
    assert.equal(pushes[0].body, '【PC: CEO_S】\n送信本文', 'Push must display the registered PC, not a caller badge')
    const result = await response.json()
    assert.equal((result.post || result.message).author.display_name, 'TSG君')
    reset(type)
    assert.equal((await api.POST(request({ group_id: groupId, content: '本文', attachments: [attachment('other_file')] }))).status, 403)
    assert.equal(postWrites().length, 0)
    reset(type)
    const codexMtgResponse = await api.POST(request({ group_id: 'immutable-codex-mtg', content: '専用経路を利用すべき本文' }))
    assert.equal(codexMtgResponse.status, 403)
    assert.equal((await codexMtgResponse.json()).error, 'CodexMTGへの投稿は専用 codex_mtg_report / codex_mtg_request を使用してください')
    assert.equal(postWrites().length, 0, 'Generic MCP must not enter the dedicated CodexMTG insert guard')
    assert.equal(reads.some(read => read.table === 'gw_group_members'), true, 'The verified principal membership is checked first')
    for (const patch of [{ content: '変更本文' }, { attachments: [attachment('owned_file')] }, { action: 'pin', is_pinned: true }]) {
      reset(type)
      existing.group_id = 'immutable-codex-mtg'
      existing.user_id = principal.id
      const response = await api.PATCH(request({ post_id: existing.id, message_id: existing.id, ...patch }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error, 'CodexMTGの編集は通常画面を使用してください。Codex投稿は専用MCP codex_mtg_report / codex_mtg_request を使用してください')
      assert.equal(writes.length, 0, 'Generic MCP cannot change a human CodexMTG post into a bot post')
      assert.equal(reads.some(read => read.table === 'gw_group_members'), true, 'Membership is checked before refusing the mutation')
    }
    reset(type); activeContext = undefined
    existing.group_id = 'immutable-codex-mtg'; existing.user_id = principal.id
    assert.equal((await api.PATCH(request({ post_id: existing.id, message_id: existing.id, content: '画面から修正' }))).status, 200)
    assert.equal(postWrites()[0].mutation[1].content, '画面から修正', 'The ordinary screen can still edit its own human CodexMTG post')
    reset(type); member = false
    assert.equal((await api.POST(request({ group_id: groupId, content: '本文' }))).status, 403)
    assert.equal(postWrites().length, 0)
    reset(type)
    const body = { post_id: existing.id, message_id: existing.id, content: '変更本文', user_id: 'forged' }
    assert.equal((await api.PATCH(request(body))).status, 200)
    assert.equal(postWrites()[0].mutation[1].content, '【PC: CEO_S】\n変更本文')
    assert.equal(postWrites()[0].mutation[1].user_id, botId)
    reset(type)
    existing.attachments = [attachment('arbitrary_drive_id')]
    direct = type === 'chat'
    assert.equal((await api.DELETE(request({}, `?post_id=${existing.id}&message_id=${existing.id}`))).status, 200)
    assert.equal(driveDeletes.length, 0, 'MCP post deletion cannot delete any Drive object')
    reset(type); activeContext = undefined; existing.user_id = principal.id; existing.attachments = [attachment('ui_owned_file')]
    assert.equal((await api.DELETE(request({}, `?post_id=${existing.id}&message_id=${existing.id}`))).status, 200)
    assert.deepEqual(driveDeletes, ['ui_owned_file'], 'Existing browser delete behavior is preserved')
    reset(type); activeContext = undefined
    assert.equal((await api.POST(request({ group_id: groupId, content: '画面から投稿', attachments: [legacy] }))).status, 201)
    assert.equal(postWrites()[0].mutation[1].user_id, principal.id)
    assert.equal(postWrites()[0].mutation[1].content, '画面から投稿')
  }
  reset('chat'); direct = true
  assert.equal((await chat.POST(request({ group_id: groupId, content: 'Codexの連絡' }))).status, 201)
  assert.equal(aiCalls, 0, 'Automated TSG君 posts cannot retrigger AI on an old human message')
  reset('board')
  assert.equal((await posts.POST(request({ group_id: groupId, attachments: [{}] }))).status, 400)
  assert.equal(postWrites().length, 0)
  reset('board'); existing.attachments = [legacy]
  assert.equal((await posts.PATCH(request({ post_id: existing.id, action: 'attachments', attachments: [legacy] }))).status, 200)
  reset('chat'); existing.attachments = [legacy]
  assert.equal((await chat.PATCH(request({ message_id: existing.id, attachments: [legacy] }))).status, 200)
  reset('board')
  assert.equal((await posts.PATCH(request({ post_id: existing.id, action: 'attachments', attachments: [attachment('other_file')] }))).status, 403)
  assert.equal(postWrites().length, 0)
  reset('chat')
  assert.equal((await chat.PATCH(request({ message_id: existing.id, attachments: [attachment('other_file')] }))).status, 403)
  assert.equal(postWrites().length, 0)
  reset('chat'); existing.group_id = 'immutable-codex-mtg'
  assert.equal((await chat.DELETE(request({}, `?message_id=${existing.id}`))).status, 403)
  assert.equal(postWrites().length, 0)

  const uploadRequest = { formData: async () => ({ get: () => ({ size: 3, name: 'test.png', type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }) }
  reset()
  assert.equal((await upload.POST(uploadRequest)).status, 200)
  assert.deepEqual(writes.find(write => write.table === 'gw_data_business_uploads').mutation[1], { connection_id: context.connectionId, drive_id: 'uploaded_file' })
  reset(); uploadTrackError = true
  const originalError = console.error
  console.error = () => {}
  try { assert.equal((await upload.POST(uploadRequest)).status, 500) }
  finally { console.error = originalError }
  assert.deepEqual(driveDeletes, ['uploaded_file'], 'Failed tracking cleans up only the just-created upload')
  reset(); activeContext = undefined
  assert.equal((await upload.POST(uploadRequest)).status, 200)
  assert.equal(writes.length, 0, 'Browser uploads do not enter the MCP ownership registry')
  console.log('Business posting passed: verified PC attribution, principal authorization, scoped attachment ownership, reference-only MCP deletion, upload tracking failure cleanup, existing browser behavior; all synthetic')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
