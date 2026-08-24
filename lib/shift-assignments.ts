export const SHIFT_COMPANY_OFF_NOTE = "__company_off__";

export function isCompanyOffAssignment(assignment: {
  shift_label?: string | null;
  note?: string | null;
} | null | undefined) {
  return Boolean(assignment && !assignment.shift_label && assignment.note === SHIFT_COMPANY_OFF_NOTE);
}

export function isRoadStationHeadquartersShift(assignment: {
  shift_label?: string | null;
} | null | undefined) {
  const label = String(assignment?.shift_label || "").normalize("NFKC").replace(/\s+/g, "");
  return label === "本社" || label.startsWith("本社勤務");
}

export function countsTowardDepartmentHeadcount(
  department: string,
  assignment: { shift_label?: string | null; assignment_type?: string | null } | null | undefined,
) {
  if (!assignment?.shift_label || assignment.assignment_type === "timee") return false;
  return department !== "道の駅" || !isRoadStationHeadquartersShift(assignment);
}
