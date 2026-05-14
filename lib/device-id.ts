const DEVICE_ID_KEY = 'tsg-device-id'

function createDeviceId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getDeviceId() {
  if (typeof window === 'undefined') return ''

  const existing = window.localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing

  const deviceId = createDeviceId()
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId)
  return deviceId
}

export function getDeviceHeaders(): Record<string, string> {
  const deviceId = getDeviceId()
  return deviceId ? { 'x-tsg-device-id': deviceId } : {}
}
