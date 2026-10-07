export const PRODUCTION_ORIGIN = 'https://v0-line-blush.vercel.app'
const MAX_RESPONSE_BYTES = 1_048_576
const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|token|token_hash|access_token|refresh_token|api_key|secret|service_role_key|TSG_DATA_API_TOKEN)$/i
const TOKEN_PATTERN = /\btsg_data_[A-Za-z0-9_-]{32,248}\b/g

export function loadConfig(env = process.env) {
  const token = env.TSG_DATA_API_TOKEN || ''
  if (!/^tsg_data_[A-Za-z0-9_-]{40,128}$/.test(token)) {
    throw new Error('TSG_CONFIG_TOKEN_INVALID')
  }
  let base
  try { base = new URL(env.TSG_DATA_API_BASE_URL || PRODUCTION_ORIGIN) } catch { throw new Error('TSG_CONFIG_ORIGIN_INVALID') }
  if (base.origin !== PRODUCTION_ORIGIN || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('TSG_CONFIG_ORIGIN_INVALID')
  }
  return Object.freeze({ token, endpoint: `${PRODUCTION_ORIGIN}/api/data/v1/execute` })
}

export function redact(value, token, depth = 0) {
  if (depth > 32) throw new Error('TSG_RESPONSE_INVALID')
  if (typeof value === 'string') return value.split(token).join('[redacted]').replace(TOKEN_PATTERN, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redact(item, token, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redact(key, token, depth + 1), SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(item, token, depth + 1),
  ]))
  return value
}

export function apiError(code, message) {
  return { ok: false, error: { code, message } }
}

async function readJson(response) {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('TSG_RESPONSE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new Error('TSG_RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export async function execute(config, envelope, fetchImpl = globalThis.fetch) {
  try {
    const body = JSON.stringify(envelope)
    if (body.includes(config.token) || TOKEN_PATTERN.test(body)) {
      TOKEN_PATTERN.lastIndex = 0
      return apiError('SENSITIVE_INPUT', 'Credentials must not appear in tool arguments.')
    }
    TOKEN_PATTERN.lastIndex = 0
    if (Buffer.byteLength(body, 'utf8') > 32_768) return apiError('INPUT_TOO_LARGE', 'The request exceeds the allowed size.')
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    const parsed = await readJson(response)
    if (!parsed || typeof parsed !== 'object' || ![true, false].includes(parsed.ok)
      || (parsed.ok && (!response.ok || !Object.hasOwn(parsed, 'data')))
      || (!parsed.ok && (!parsed.error || typeof parsed.error.code !== 'string' || typeof parsed.error.message !== 'string'))) {
      return apiError('UPSTREAM_RESPONSE_INVALID', 'TSG returned an invalid response.')
    }
    // No automatic retry: a failed response may follow a successful mutation.
    return redact(parsed, config.token)
  } catch {
    // Do not expose fetch/parse exceptions: they may contain headers or URLs.
    return apiError('TSG_REQUEST_FAILED', 'TSG could not be reached or returned an invalid response. Keep the same idempotency key when checking an uncertain write.')
  }
}
