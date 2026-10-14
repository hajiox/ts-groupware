const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { isDeepStrictEqual } = require('node:util')
const ts = require('typescript')
const sharp = require('sharp')

function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => dependencies[name] || require(name))
  return loaded.exports
}
const image = load('lib/doc-scanner-fax-image.ts')
const summary = load('lib/doc-scanner-fax-post.ts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const board = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'FAX受信', type: 'board' }
const botId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const postId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const replyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const sourceKey = 'fax:fixture-1'
const originalContent = `【FAX受信】\n保持すべきヘッダ\n\n【AI要約】\n確定済みの要約\n\n受信ID: ${sourceKey}`
const originalAttachments = [{ driveId: 'old-drive-1', name: 'old.jpg', type: 'image/jpeg', url: 'https://example.invalid/old', sourcePage: 1 }]
let posts, uploads, pushes, inserts, updates, queries, uploadHook, nextPostId
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
function reset(existing = true) {
  posts = new Map(existing ? [[postId, { id: postId, group_id: board.id, user_id: botId, content: originalContent,
    attachments: clone(originalAttachments), parent_id: null, created_at: '2026-01-01T00:00:00Z' }],
  [replyId, { id: replyId, group_id: board.id, user_id: 'human', content: '保持すべき返信', parent_id: postId }]] : [])
  uploads = []; pushes = 0; inserts = 0; updates = []; queries = []; uploadHook = null; nextPostId = 1
}
const adminClient = { from(table) {
  let operation = 'read', payload
  const filters = []
  function matches(row) {
    return filters.every(([kind, key, value]) => {
      if (kind === 'ilike') return String(row[key] || '').includes(value.slice(1, -1))
      if (key === 'attachments') return isDeepStrictEqual(row[key], JSON.parse(value))
      return row[key] === value
    })
  }
  function execute() {
    queries.push({ table, operation, filters: clone(filters) })
    const rows = table === 'gw_groups' ? [board] : [...posts.values()]
    if (operation === 'insert') {
      inserts++
      const row = { ...clone(payload), id: `new-post-${nextPostId++}`, created_at: '2026-10-14T00:00:00Z' }
      posts.set(row.id, row)
      return { data: [clone(row)], error: null }
    }
    const selected = rows.filter(matches)
    if (operation === 'update') {
      updates.push({ table, payload: clone(payload), count: selected.length })
      for (const row of selected) Object.assign(row, clone(payload))
    }
    return { data: clone(selected), error: null }
  }
  const query = {
    select() { return query }, eq(key, value) { filters.push(['eq', key, value]); return query },
    is(key, value) { filters.push(['is', key, value]); return query },
    ilike(key, value) { filters.push(['ilike', key, value]); return query },
    order() { return query }, limit() { return query },
    update(value) { operation = 'update'; payload = value; return query },
    insert(value) { operation = 'insert'; payload = value; return query },
    async maybeSingle() { const result = execute(); return { ...result, data: result.data[0] || null } },
    async single() { const result = execute(); return { ...result, data: result.data[0] || null } },
    then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject) },
  }
  return query
} }
const route = load('app/api/integrations/doc-scanner/fax-received/route.ts', {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
  '@/lib/supabase/admin': { adminClient }, '@/lib/tsg-ai': { getTsgUserId: async () => botId },
  '@/lib/doc-scanner-fax-post': summary, '@/lib/doc-scanner-fax-image': image,
  '@/lib/drive': { uploadFileToDrive: async (buffer, name, type) => {
    uploads.push({ buffer, name, type })
    if (uploadHook) await uploadHook()
    return { id: `saved-drive-${uploads.length}`, webViewLink: `https://example.invalid/saved-${uploads.length}` }
  } },
  '@/lib/web-push': { sendPushNotificationToGroup: async () => { pushes++ } },
})
const secret = 'test-fax-integration-only'
const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
function request(body, authenticated = true, method = 'POST') {
  return new Request('http://localhost/api/integrations/doc-scanner/fax-received', {
    method, headers: authenticated ? headers : {}, body: JSON.stringify(body),
  })
}
async function darkness(buffer, left, top) {
  const pixel = await sharp(buffer).extract({ left, top, width: 1, height: 1 }).grayscale().raw().toBuffer()
  return pixel[0]
}

async function main() {
  // A normal bottom-heavy document triggers the former ink heuristic. Its
  // actual page coordinates must remain unchanged without explicit EXIF.
  const raw = Buffer.alloc(80 * 120 * 3, 255)
  for (let y = 80; y < 110; y++) for (let x = 10; x < 70; x++) {
    raw.fill(0, (y * 80 + x) * 3, (y * 80 + x) * 3 + 3)
  }
  const input = await sharp(raw, { raw: { width: 80, height: 120, channels: 3 } }).jpeg().toBuffer()
  const normalized = await image.normalizeFaxImageBuffer(input)
  assert.ok(await darkness(normalized.buffer, 40, 95) < 15)
  assert.ok(await darkness(normalized.buffer, 40, 20) > 240)
  assert.equal(normalized.rotationCorrected, false)
  assert.equal(normalized.receivedSha256, hash(input))
  assert.equal(normalized.storedSha256, hash(normalized.buffer))
  for (const orientation of [3, 6]) {
    const withExif = await sharp(input).withMetadata({ orientation }).toBuffer()
    const result = await image.normalizeFaxImageBuffer(withExif)
    const metadata = await sharp(result.buffer).metadata()
    assert.equal(metadata.orientation, undefined)
    if (orientation === 3) {
      assert.ok(await darkness(result.buffer, 40, 20) < 15)
      assert.ok(await darkness(result.buffer, 40, 95) > 240)
    } else {
      assert.equal(metadata.width, 120); assert.equal(metadata.height, 80)
      assert.ok(await darkness(result.buffer, 20, 40) < 15)
      assert.ok(await darkness(result.buffer, 100, 40) > 240)
    }
  }
  const receipt = { version: 2, owner: 'docscanner', page: 1, sha256: hash(input), rotationDegrees: 180,
    status: 'corrected', method: 'body-text-pair', confidence: 0.95 }
  assert.deepEqual(image.parseFaxOrientationReceipt(receipt, 1, 1), receipt)
  assert.equal(image.parseFaxOrientationReceipt(undefined), undefined)
  for (const status of ['upright', 'uncertain']) {
    const unchangedReceipt = { ...receipt, status, rotationDegrees: 0, confidence: 0.5 }
    assert.deepEqual(image.parseFaxOrientationReceipt(unchangedReceipt, 1, 1), unchangedReceipt)
    assert.ok(await darkness((await image.normalizeFaxImageBuffer(input, unchangedReceipt)).buffer, 40, 95) < 15)
  }
  for (const field of Object.keys(receipt)) {
    const incomplete = { ...receipt }; delete incomplete[field]
    assert.throws(() => image.parseFaxOrientationReceipt(incomplete, 1, 1), image.FaxImageInputError)
  }
  for (const patch of [{ version: 1 }, { owner: 'tsg' }, { page: 0 }, { page: 1.5 }, { sha256: 'bad' },
    { rotationDegrees: 90 }, { status: 'corrected', rotationDegrees: 0 }, { status: 'upright' },
    { status: 'uncertain' }, { method: 'ink-balance' }, { confidence: -1 }, { confidence: 1.01 },
    { confidence: '0.95' }, { extra: true }]) {
    assert.throws(() => image.parseFaxOrientationReceipt({ ...receipt, ...patch }, 1, 1), image.FaxImageInputError)
  }
  for (const args of [[receipt, 2, 2], [receipt, undefined, 1], [receipt, 1, 0], [receipt, 1, 1.5], [null, 1, 1]]) {
    assert.throws(() => image.parseFaxOrientationReceipt(...args), image.FaxImageInputError)
  }
  const corrected = await image.normalizeFaxImageBuffer(input, receipt)
  assert.ok(await darkness(corrected.buffer, 40, 95) < 15, 'DocScanner receipt must never trigger another 180 rotation')
  assert.equal(corrected.rotationCorrected, true)
  await assert.rejects(image.normalizeFaxImageBuffer(input, { ...receipt, sha256: '0'.repeat(64) }), /hash mismatch/)
  await assert.rejects(image.normalizeFaxImageBuffer(Buffer.from('not an image')), /could not be normalized/)

  const attachment = { name: 'fixture.jpg', type: 'image/jpeg', dataBase64: input.toString('base64'),
    sourcePage: 1, sourcePageCount: 1, orientation: receipt }
  const repair = { action: 'repair-attachments', postId, sourceKey, expectedDriveIds: ['old-drive-1'], attachments: [attachment] }
  process.env.TSG_INTEGRATION_SECRET = secret
  reset()
  assert.equal((await route.POST(request(repair, false))).status, 401)
  assert.equal(queries.length, 0); assert.equal(uploads.length, 0)
  const readiness = await route.GET(new Request('http://localhost/api/integrations/doc-scanner/fax-received', { headers }))
  assert.equal(readiness.status, 200)
  assert.deepEqual(readiness.body.capabilities, { orientationReceiptVersion: 2, semanticRotation: false, repairAttachments: true })
  assert.equal(readiness.body.group.id, board.id); assert.equal(readiness.body.poster.id, botId)
  assert.equal(uploads.length, 0); assert.equal(inserts, 0)
  for (const patch of [{ postId: 'bad' }, { sourceKey: '' }, { sourceKey: 'fax:one\n受信ID: other' },
    { expectedDriveIds: undefined }, { expectedDriveIds: [1] }]) {
    reset(); assert.equal((await route.POST(request({ ...repair, ...patch }))).status, 400)
    assert.equal(uploads.length, 0); assert.equal(inserts, 0)
  }
  for (const patch of [{ postId: replyId }, { postId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    { sourceKey: 'fax:fixture' }, { expectedDriveIds: ['other-drive'] }, { expectedDriveIds: [] }]) {
    reset(); const result = await route.POST(request({ ...repair, ...patch }))
    assert.ok([404, 409].includes(result.status)); assert.equal(uploads.length, 0); assert.equal(inserts, 0)
  }
  for (const changed of [{ group_id: 'different-board' }, { user_id: 'human' }]) {
    reset(); Object.assign(posts.get(postId), changed)
    assert.equal((await route.POST(request(repair))).status, 404); assert.equal(uploads.length, 0)
  }
  reset()
  posts.get(postId).attachments.push({ driveId: 'old-drive-2', type: 'image/jpeg' })
  assert.equal((await route.POST(request({ ...repair, expectedDriveIds: ['old-drive-2', 'old-drive-1'] }))).status, 409)
  assert.equal(uploads.length, 0)
  for (const attachments of [[{ ...attachment, orientation: { ...receipt, sha256: '0'.repeat(64) } }],
    [{ ...attachment, orientation: { ...receipt, extra: true } }],
    [{ ...attachment, sourcePageCount: 'invalid' }],
    [{ ...attachment, dataBase64: undefined, driveId: 'existing-without-image-bytes' }],
    [{ ...attachment, orientation: undefined, dataBase64: Buffer.from('invalid').toString('base64') }],
    [{ ...attachment, dataBase64: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }]]) {
    reset(); assert.equal((await route.POST(request({ ...repair, attachments }))).status, 400)
    assert.equal(uploads.length, 0); assert.equal(updates.length, 0); assert.equal(inserts, 0)
  }
  reset()
  posts.get(postId).attachments[0].sourcePageCount = 2
  posts.get(postId).attachments.push({ driveId: 'old-drive-2', sourcePage: 2, sourcePageCount: 2 })
  assert.equal((await route.POST(request({ ...repair, expectedDriveIds: ['old-drive-1', 'old-drive-2'],
    attachments: [{ ...attachment, sourcePageCount: 2 }, { ...attachment, sourcePage: 2, sourcePageCount: 2,
      orientation: { ...receipt, page: 2, sha256: '0'.repeat(64) } }] }))).status, 400)
  assert.equal(uploads.length, 0)
  for (const changed of [{ sourcePage: 2 }, { sourcePageCount: 2 }, { docScannerFileHash: 'original-file-hash' }]) {
    reset(); Object.assign(posts.get(postId).attachments[0], changed)
    assert.equal((await route.POST(request(repair))).status, 409)
    assert.equal(uploads.length, 0)
  }
  reset()
  assert.equal((await route.POST(request({ ...repair, attachments: [attachment, attachment] }))).status, 409)
  assert.equal(uploads.length, 0)
  reset()
  const result = await route.POST(request(repair))
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.repaired, true)
  assert.equal(result.body.post.id, postId); assert.equal(result.body.post.content, originalContent)
  assert.equal(result.body.post.created_at, '2026-01-01T00:00:00Z')
  assert.equal(posts.get(replyId).content, '保持すべき返信'); assert.equal(posts.size, 2)
  assert.equal(inserts, 0); assert.equal(pushes, 0); assert.equal(uploads.length, 1)
  const saved = result.body.post.attachments[0]
  assert.deepEqual(saved.orientation, receipt); assert.equal(saved.receivedSha256, hash(input))
  assert.equal(saved.storedSha256, hash(uploads[0].buffer)); assert.equal(saved.driveId, 'saved-drive-1')
  assert.ok(await darkness(uploads[0].buffer, 40, 95) < 15)
  const update = updates.find(item => item.table === 'gw_posts')
  assert.deepEqual(Object.keys(update.payload), ['attachments'])
  assert.equal(queries.some(query => query.filters.some(([kind]) => kind === 'ilike')), false)
  const uploadsAfterRepair = uploads.length
  assert.equal((await route.POST(request(repair))).status, 409)
  assert.equal(uploads.length, uploadsAfterRepair)
  reset()
  uploadHook = () => { posts.get(postId).attachments[0].name = 'concurrent-metadata-edit.jpg' }
  assert.equal((await route.POST(request(repair))).status, 409)
  assert.equal(posts.get(postId).attachments[0].name, 'concurrent-metadata-edit.jpg')
  assert.equal(posts.get(postId).content, originalContent); assert.equal(inserts, 0); assert.equal(pushes, 0)
  reset()
  posts.get(postId).attachments[0].docScannerFileHash = 'immutable-original-file-hash'
  assert.equal((await route.POST(request({ ...repair, attachments: [{ ...attachment,
    docScannerFileHash: 'immutable-original-file-hash' }] }))).status, 200)
  assert.equal(posts.get(postId).attachments[0].docScannerFileHash, 'immutable-original-file-hash')
  reset()
  uploadHook = () => { posts.get(postId).content = `${originalContent}\n同時に追記された本文` }
  assert.equal((await route.POST(request(repair))).status, 200)
  assert.match(posts.get(postId).content, /同時に追記された本文$/)
  reset(false)
  const legacy = { sourceKey, senderLabel: '検証送信元', subject: '検証FAX', receivedAt: '2026-10-14T00:00:00Z',
    attachments: [{ ...attachment, orientation: undefined }] }
  const first = await route.POST(request(legacy))
  assert.equal(first.status, 201); assert.equal(pushes, 1); assert.equal(inserts, 1)
  const legacyImage = first.body.post.attachments[0]
  assert.equal(legacyImage.orientation, undefined); assert.equal(legacyImage.receivedSha256, hash(input))
  assert.ok(await darkness(uploads[0].buffer, 40, 95) < 15)
  const patched = await route.PATCH(request({ sourceKey, summaryStatus: 'completed', summary: '確定済みの要約' }, true, 'PATCH'))
  assert.equal(patched.status, 200)
  const replay = await route.POST(request(legacy))
  assert.equal(replay.status, 200); assert.equal(replay.body.post.id, first.body.post.id)
  assert.match(replay.body.post.content, /確定済みの要約/); assert.equal(pushes, 1); assert.equal(inserts, 1)
  reset(false)
  const passThrough = await route.POST(request({ ...legacy, attachments: [{ name: 'existing.jpg', type: 'image/jpeg',
    driveId: 'legacy-drive', url: 'https://example.invalid/legacy' }] }))
  assert.equal(passThrough.status, 201); assert.equal(uploads.length, 0)
  console.log('FAX EXIF-only normalization, orientation receipts and byte hashes, safe attachment repair/CAS, and legacy POST/PATCH verified (no live posts).')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
