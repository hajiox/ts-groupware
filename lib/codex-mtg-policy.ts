export const CODEX_MTG_GROUP_ID = 'a8081dbe-15db-4d41-a18b-b22bb55d2b39'
export const OWNER_PC_NAME = 'TSA'
export const CODEX_MTG_BOT_USER_ID = 'f78baef5-d40c-4886-b51d-a02efbf794fe'

export function isCodexMtgGroup(groupId: unknown): boolean {
  return typeof groupId === 'string' && groupId.toLowerCase() === CODEX_MTG_GROUP_ID
}
