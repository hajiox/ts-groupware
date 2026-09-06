export type ConversationMessage = { role: string; parts: { text: string }[] }

// Character budget, not a measured token estimate. Keep complete recent messages.
export const CHAT_HISTORY_MAX_CHARS = 16_000

export function boundConversationHistory(messages: ConversationMessage[], maxChars = CHAT_HISTORY_MAX_CHARS) {
  const nonempty = messages.filter(message => message.parts.some(part => part.text.trim()))
  const selected: ConversationMessage[] = []
  let chars = 0
  for (let index = nonempty.length - 1; index >= 0; index -= 1) {
    const message = nonempty[index]
    const size = message.parts.reduce((sum, part) => sum + part.text.length, 0)
    if (chars + size > maxChars) {
      if (selected.length === 0) throw new Error('CHAT_INPUT_TOO_LONG')
      break
    }
    selected.unshift(message)
    chars += size
  }
  // A truncated assistant reply lacks its user question. Keep the latest input,
  // but do not begin retained conversation context with an orphaned model turn.
  while (selected.length > 1 && selected[0].role === 'model') selected.shift()
  return { messages: selected, omitted: selected.length < nonempty.length }
}
