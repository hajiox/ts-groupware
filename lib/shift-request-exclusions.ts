type ShiftRequestPerson = {
  display_name?: string | null
  real_name?: string | null
}

const EXCLUDED_PERSON_NAMES = new Set(['佐藤正彦'])
const EXCLUDED_ROSTER_NAMES = new Set(['TSG君', 'TSGくん'])

function normalizePersonName(value: string | null | undefined) {
  return (value || '').replace(/[\s　]+/g, '').trim()
}

export function isShiftRequestCollectionExcluded(person: ShiftRequestPerson | null | undefined) {
  if (!person) return false
  return [person.real_name, person.display_name]
    .map(normalizePersonName)
    .some((name) => EXCLUDED_PERSON_NAMES.has(name))
}

export function isShiftRosterExcluded(person: ShiftRequestPerson | null | undefined) {
  if (!person) return false
  return [person.real_name, person.display_name]
    .map(normalizePersonName)
    .some((name) => EXCLUDED_ROSTER_NAMES.has(name))
}
