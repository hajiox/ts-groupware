import { NextRequest } from 'next/server'

type NetworkCheckReason =
  | 'allowed'
  | 'allow_all'
  | 'dev_no_allowlist'
  | 'missing_allowlist'
  | 'missing_ip'
  | 'not_allowed'

export type AttendanceNetworkCheck = {
  allowed: boolean
  ip: string | null
  label: string | null
  configured: boolean
  reason: NetworkCheckReason
}

function normalizeIp(value: string | null) {
  if (!value) return null

  let ip = value.trim()
  if (!ip) return null

  if (ip.includes(',')) {
    ip = ip.split(',')[0]?.trim() || ''
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length)
  }

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'))
  }

  const portMatch = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (portMatch) ip = portMatch[1]

  return ip || null
}

function getAllowedEntries() {
  const anonymousEntries = (process.env.TSG_ATTENDANCE_ALLOWED_IPS || '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ matcher: entry, label: null as string | null }))

  const namedEntries = (process.env.TSG_ATTENDANCE_ALLOWED_NETWORKS || '')
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf('=')
      if (separatorIndex < 0) return { matcher: entry, label: null as string | null }
      const label = entry.slice(0, separatorIndex).trim() || null
      const matcher = entry.slice(separatorIndex + 1).trim()
      return { matcher, label }
    })
    .filter((entry) => entry.matcher)

  return [...anonymousEntries, ...namedEntries]
}

function ipV4ToInt(ip: string) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number(part)
    if (value < 0 || value > 255) return null
    result = (result << 8) + value
  }

  return result >>> 0
}

function matchesCidr(ip: string, cidr: string) {
  const [rangeIp, prefixText] = cidr.split('/')
  const prefix = Number(prefixText)
  if (!rangeIp || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false

  const ipValue = ipV4ToInt(ip)
  const rangeValue = ipV4ToInt(rangeIp)
  if (ipValue === null || rangeValue === null) return false

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipValue & mask) === (rangeValue & mask)
}

function matchesAllowedEntry(ip: string, entry: string) {
  const normalizedEntry = normalizeIp(entry)
  if (!normalizedEntry) return false
  if (normalizedEntry === '*') return true
  if (normalizedEntry.includes('/')) return matchesCidr(ip, normalizedEntry)
  return ip === normalizedEntry
}

export function getRequestIp(request: NextRequest) {
  const headers = request.headers
  return normalizeIp(
    headers.get('x-vercel-forwarded-for')
    || headers.get('x-forwarded-for')
    || headers.get('x-real-ip')
    || headers.get('cf-connecting-ip')
    || null,
  )
}

export function checkAttendanceNetwork(request: NextRequest): AttendanceNetworkCheck {
  const ip = getRequestIp(request)
  const allowAll = /^(1|true|yes|\*)$/i.test(process.env.TSG_ATTENDANCE_ALLOW_ALL || '')
  const entries = getAllowedEntries()
  const configured = allowAll || entries.length > 0

  if (allowAll) {
    return { allowed: true, ip, label: '開発', configured, reason: 'allow_all' }
  }

  if (entries.length === 0) {
    if (process.env.NODE_ENV !== 'production') {
      return { allowed: true, ip, label: '開発', configured, reason: 'dev_no_allowlist' }
    }
    return { allowed: false, ip, label: null, configured, reason: 'missing_allowlist' }
  }

  if (!ip) {
    return { allowed: false, ip, label: null, configured, reason: 'missing_ip' }
  }

  const matchedEntry = entries.find((entry) => matchesAllowedEntry(ip, entry.matcher))
  const allowed = !!matchedEntry
  return {
    allowed,
    ip,
    label: matchedEntry?.label || null,
    configured,
    reason: allowed ? 'allowed' : 'not_allowed',
  }
}
