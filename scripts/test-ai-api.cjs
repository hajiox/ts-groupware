const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, customRequire = require) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, customRequire)
  return loaded.exports
}

async function main() {
  const { boundConversationHistory } = load('lib/tsg-ai-history.ts')
  const msg = (text, role = 'user') => ({ role, parts: [{ text }] })
  const history = [msg('old'), msg('reply', 'model'), msg('latest')]
  assert.deepEqual(boundConversationHistory(history, 11), { messages: history.slice(1), omitted: true })
  assert.deepEqual(boundConversationHistory(history, 14), { messages: history, omitted: false })
  assert.deepEqual(boundConversationHistory([msg('  '), msg('latest')], 6), { messages: [msg('latest')], omitted: false })
  assert.deepEqual(boundConversationHistory([], 6), { messages: [], omitted: false })
  assert.throws(() => boundConversationHistory([msg('最新の入力')], 3), /CHAT_INPUT_TOO_LONG/)

  const { generateGeminiContent } = load('lib/gemini-api.ts')
  const originalFetch = global.fetch
  const originalInfo = console.info
  const logs = []
  const input = { apiKey: 'secret-test-key', model: 'gemini-3.1-flash-lite', task: 'chat',
    timeoutMs: 1000, body: { contents: [{ text: 'private-test-body' }] } }
  console.info = (...args) => logs.push(args.join(' '))
  try {
    global.fetch = async (url, options) => {
      assert(!url.includes(input.apiKey))
      assert.equal(options.headers['x-goog-api-key'], input.apiKey)
      assert.deepEqual(JSON.parse(options.body), input.body)
      assert(options.signal instanceof AbortSignal)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private-test-result' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, totalTokenCount: 58,
          cachedContentTokenCount: -1, other: 'private-extra' } }), { status: 200 })
    }
    const result = await generateGeminiContent(input)
    assert.equal(result.candidates[0].content.parts[0].text, 'private-test-result')
    const metric = JSON.parse(logs[0].slice('[AI usage] '.length))
    assert.equal(metric.version, 1)
    assert.equal(metric.system, 'tsg')
    assert.equal(metric.provider, 'gemini')
    assert.equal(metric.totalTokens, 58)
    assert.equal(metric.cachedInputTokens, null)
    assert.equal(metric.status, 'success')
    assert.equal(metric.httpStatus, 200)

    global.fetch = async () => new Response('secret-test-key private-test-body', { status: 429 })
    await assert.rejects(generateGeminiContent(input), /HTTP 429/)
    global.fetch = async () => new Response('{private-test-body', { status: 200 })
    await assert.rejects(generateGeminiContent(input), /通信に失敗/)
    global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private-test-body')), { once: true })
    })
    // Keep the test event loop active; AbortSignal.timeout alone is unref'ed.
    const keepAlive = setTimeout(() => {}, 200)
    try { await assert.rejects(generateGeminiContent({ ...input, timeoutMs: 10 }), /通信に失敗/) }
    finally { clearTimeout(keepAlive) }
    assert.equal(logs.length, 4)
    assert(!logs.join('').match(/secret-test-key|private-test-body|private-test-result|private-extra/))
    console.info = () => { throw new Error('logger failed') }
    global.fetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
    assert.deepEqual(await generateGeminiContent(input), { candidates: [] })
    global.fetch = async () => new Response('', { status: 503 })
    await assert.rejects(generateGeminiContent(input), /HTTP 503/)
  } finally {
    global.fetch = originalFetch
    console.info = originalInfo
  }
  const originalKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-key'
  try {
    const ocr = load('lib/hr-resume-ocr.ts', name => {
      if (name === '@/lib/gemini-api') return { generateGeminiContent: async request => {
        assert.equal(request.task, 'resume-ocr')
        assert.equal(request.timeoutMs, 45_000)
        assert.equal(request.body.generationConfig.maxOutputTokens, 4096)
        assert.equal(request.body.generationConfig.temperature, 0)
        assert.equal(request.body.generationConfig.responseMimeType, 'application/json')
        assert.equal(request.body.contents[0].parts[1].inline_data.mime_type, 'application/pdf')
        return { candidates: [{ content: { parts: [{ text: '{"full_name":"Mock Person"}' }] } }] }
      } }
      if (name === '@/lib/drive') return { extractTextFromPdfWithDriveOcr: async () => { throw new Error('Unexpected fallback') } }
      return require(name)
    })
    const result = await ocr.extractResumeFromPdf(Buffer.from('%PDF-mock'))
    assert.equal(result.result.full_name, 'Mock Person')
    assert.equal(result.provider, 'google-gemini')
    assert.equal(result.model, process.env.GEMINI_OCR_MODEL?.trim() || 'gemini-3.1-flash-lite')
    let apiCalls = 0
    let rows = [
      { user_id: 'user', content: 'latest' },
      { user_id: 'tsg', content: 'old'.repeat(6000) },
    ]
    const posted = []
    const chat = load('lib/tsg-ai.ts', name => {
      if (name === '@/lib/tsg-ai-history') return load('lib/tsg-ai-history.ts')
      if (name === '@/lib/supabase/admin') return { adminClient: { from: () => {
        const query = {
          select: () => query, eq: () => query, is: () => query, order: () => query,
          single: async () => ({ data: { id: 'tsg' } }),
          limit: async () => ({ data: rows }),
          insert: async value => { posted.push(value.content) },
          update: () => query,
        }
        return query
      } } }
      if (name === '@/lib/gemini-api') return { generateGeminiContent: async request => {
        apiCalls += 1
        assert.equal(request.model, 'gemini-3.1-flash-lite')
        assert.equal(request.body.generationConfig.maxOutputTokens, 1024)
        assert.equal(request.body.generationConfig.temperature, 0.7)
        assert.deepEqual(request.body.contents, [msg('latest')])
        assert.match(request.body.system_instruction.parts[0].text, /省略/)
        return { candidates: [{ content: { parts: [{ text: 'reply' }] } }] }
      } }
      return require(name)
    })
    await chat.handleTsgAiResponse('test-group', 'user')
    assert.equal(apiCalls, 1)
    assert.equal(posted[0], 'reply')
    rows = [{ user_id: 'user', content: 'x'.repeat(16001) }]
    const originalError = console.error
    console.error = () => {}
    try { await chat.handleTsgAiResponse('test-group', 'user') }
    finally { console.error = originalError }
    assert.equal(apiCalls, 1, 'oversized latest input must not spend tokens')
    assert.match(posted[1], /16,000文字以内/)
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
  console.log('AI API privacy, timeout, usage and conversation budget checks passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
