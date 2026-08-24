export type ShiftDeadlineTone = 'normal' | 'soon' | 'today' | 'overdue' | 'unset'

export type ShiftDeadlineInfo = {
  tone: ShiftDeadlineTone
  label: string
  shortLabel: string
  daysRemaining: number | null
}

function jstDateText(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function isShiftRequestDeadlineOpen(deadline: string | null | undefined, now = new Date()) {
  if (!deadline) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false
  return jstDateText(now) <= deadline
}

function dateSerial(dateText: string) {
  const [year, month, day] = dateText.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function displayDate(dateText: string) {
  const [, month, day] = dateText.split('-').map(Number)
  return `${month}月${day}日`
}

export function shiftDeadlineInfo(deadline: string | null | undefined, now = new Date()): ShiftDeadlineInfo {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return {
      tone: 'unset',
      label: '提出期限は未設定です',
      shortLabel: '期限未設定',
      daysRemaining: null,
    }
  }

  const remaining = Math.round((dateSerial(deadline) - dateSerial(jstDateText(now))) / 86400000)
  const dateLabel = displayDate(deadline)

  if (remaining < 0) {
    return {
      tone: 'overdue',
      label: `提出期限を過ぎています（${dateLabel}まで）`,
      shortLabel: `期限超過・${dateLabel}まで`,
      daysRemaining: remaining,
    }
  }
  if (remaining === 0) {
    return {
      tone: 'today',
      label: `本日が提出期限です（${dateLabel}まで）`,
      shortLabel: '本日締切',
      daysRemaining: 0,
    }
  }
  if (remaining <= 3) {
    return {
      tone: 'soon',
      label: `締切まであと${remaining}日（${dateLabel}まで）`,
      shortLabel: `あと${remaining}日・${dateLabel}まで`,
      daysRemaining: remaining,
    }
  }
  return {
    tone: 'normal',
    label: `${dateLabel}までに提出してください`,
    shortLabel: `${dateLabel}まで`,
    daysRemaining: remaining,
  }
}
