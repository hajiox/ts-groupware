const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIsoDate(value: string) {
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null
  return date
}

export function japanToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function isWaitingForNewHireMessage(hireDate: string | null | undefined, runDate: string) {
  if (!hireDate) return false
  const hire = parseIsoDate(hireDate)
  const run = parseIsoDate(runDate)
  if (!hire || !run) return false
  hire.setUTCDate(hire.getUTCDate() + 7)
  return run.getTime() < hire.getTime()
}
