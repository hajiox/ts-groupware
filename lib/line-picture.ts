const LINE_SYNC_PARAM = 'tsg_line_sync'

function stripSyncParamFromRawUrl(value: string) {
  return value
    .replace(new RegExp(`([?&])${LINE_SYNC_PARAM}=[^&]*&?`, 'g'), '$1')
    .replace(/[?&]$/, '')
    .replace('?&', '?')
}

export function normalizeLinePictureUrl(value?: string | null) {
  if (!value) return null

  try {
    const url = new URL(value)
    url.searchParams.delete(LINE_SYNC_PARAM)
    return url.toString()
  } catch {
    return stripSyncParamFromRawUrl(value)
  }
}
