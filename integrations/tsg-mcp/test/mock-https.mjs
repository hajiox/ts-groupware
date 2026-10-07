// Test-only preload. No socket is opened and no production request can occur.
let callCount = 0
globalThis.fetch = async (url, options) => {
  const token = process.env.TSG_DATA_API_TOKEN
  if (url !== 'https://v0-line-blush.vercel.app/api/data/v1/execute'
    || options.method !== 'POST' || options.headers.Authorization !== `Bearer ${token}`
    || options.redirect !== 'error' || options.credentials !== 'omit') {
    throw new Error('Mock HTTPS request contract failed')
  }
  callCount += 1
  const request = JSON.parse(options.body)
  if (request.input.query === 'network-failure') throw new Error(`Synthetic credential-bearing exception: ${token}`)
  if (request.input.query === 'non-json') return new Response(`<html>${token}</html>`, { headers: { 'content-type': 'text/html' } })
  if (request.input.query === 'oversized') return Response.json({ ok: true, data: { text: 'a'.repeat(1_048_576) } })
  if (request.input.query === 'denied') return Response.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Permission denied.' }, requestId: 'synthetic-request' }, { status: 403 })
  if (request.input.query === 'redact-test') return Response.json({
    ok: true,
    data: { authorization: `Bearer ${token}`, nested: { token, description: `Unexpected echo ${token}`, [token]: 'key must also be redacted' } },
    requestId: 'synthetic-request',
  })
  return Response.json({ ok: true, data: { request, callCount }, requestId: 'synthetic-request' })
}
