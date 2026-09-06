type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: Record<string, unknown>
}

/** No prompts, response bodies, user identifiers or credentials enter telemetry. */
export async function generateGeminiContent(input: {
  apiKey: string
  model: string
  task: 'chat' | 'resume-ocr'
  body: Record<string, unknown>
  timeoutMs: number
}): Promise<GeminiResponse> {
  const started = Date.now()
  let status: number | null = null
  let usage: Record<string, unknown> = {}
  let succeeded = false
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(input.timeoutMs),
      },
    )
    status = response.status
    if (!response.ok) throw new Error('provider-response')
    const data = await response.json() as GeminiResponse
    if (!data || typeof data !== 'object') throw new Error('provider-response')
    usage = data.usageMetadata || {}
    succeeded = true
    return data
  } catch {
    // Provider and fetch error messages can include submitted data or request details.
    throw new Error(status && status >= 400
      ? `AI APIに失敗しました（HTTP ${status}）`
      : 'AI APIの通信に失敗しました（時間切れまたは不正な応答）')
  } finally {
    const tokens: Record<string, number | null> = {}
    for (const [key, field] of Object.entries({ promptTokenCount: 'inputTokens', candidatesTokenCount: 'outputTokens',
      cachedContentTokenCount: 'cachedInputTokens', thoughtsTokenCount: 'thinkingTokens', totalTokenCount: 'totalTokens' })) {
      const value = usage[key]
      tokens[field] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }
    try {
      console.info('[AI usage]', JSON.stringify({ version: 1, system: 'tsg', provider: 'gemini',
        task: input.task, model: input.model, status: succeeded ? 'success' : 'error',
        httpStatus: status, durationMs: Date.now() - started, ...tokens }))
    } catch {
      // Observability failure must never change the business result or original error.
    }
  }
}
