"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Banknote,
  BookOpenCheck,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ContactRound,
  ExternalLink,
  FileSignature,
  FileText,
  FolderArchive,
  HeartHandshake,
  Link2,
  RefreshCw,
  Search,
  Sprout,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { AttendanceOperationManual } from "@/components/attendance-operation-manual";
import { BereavementLeaveTab } from "@/components/bereavement-leave-tab";
import { PaidLeaveOperationManual } from "@/components/paid-leave-operation-manual";
import { PaidLeaveAdminTab } from "@/components/paid-leave-admin-tab";
import { SafeLineAvatar } from "@/components/safe-line-avatar";
import { ShiftAdminTab } from "@/components/shift-admin-tab";
import { PledgeAdminTab } from "@/components/pledge-admin-tab";
import {
  RoleAccessIcons,
  UserRoleBadge,
  UserRoleIcon,
} from "@/components/user-role-badge";
import { DEFAULT_USER_DEPARTMENT, USER_DEPARTMENTS, type UserDepartment } from "@/lib/departments";
import {
  getEffectiveUserRole,
  getUserRoleLabel,
  isExecutiveUser,
  isManagementRole,
  USER_ROLE_OPTIONS,
  type UserRole,
} from "@/lib/user-roles";

type User = {
  id: string;
  display_name: string;
  real_name: string | null;
  picture_url: string | null;
  role: string;
  department: UserDepartment;
  status: "pending" | "approved" | "suspended";
  created_at: string;
};

type ManagementPermissions = {
  accessLevel: UserRole;
  canUseAdmin: boolean;
  canManageUsers: boolean;
  canManageGroups: boolean;
  canManageAttendance: boolean;
  canViewPayroll: boolean;
  canUsePersonalLeave: boolean;
  canUseBereavementLeave: boolean;
  canUseManual: boolean;
};

type Group = {
  id: string;
  name: string;
  type: "board" | "chat";
  icon: string;
};

type GroupMember = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
  department?: UserDepartment;
  group_role: string;
};

type AttendanceDevice = {
  id: string;
  code: string;
  name: string;
  location: string;
  device_key: string;
  is_active: boolean;
};

type AttendancePunch = {
  id: string;
  user_id: string;
  device_id: string | null;
  punch_type: "clock_in" | "clock_out";
  work_date: string;
  punched_at: string;
  source_type: string;
  is_voided: boolean;
  voided_at: string | null;
  void_reason: string | null;
  memo: string | null;
  private_vehicle_place: string | null;
  private_vehicle_distance_km: number | string | null;
  break_override_minutes: number | null;
  break_override_reason: string | null;
  user: {
    id: string;
    display_name: string;
    picture_url?: string | null;
    department?: string | null;
  } | null;
  device: AttendanceDevice | null;
};

type PaidLeaveAttendanceDay = {
  requestId: string;
  employeeId: string;
  userId: string;
  workDate: string;
  leaveUnit: "full_day" | "half_day" | "half_day_am" | "half_day_pm";
  requestSource: string;
  clockInTime: string;
  clockOutTime: string;
  breakMinutes: number;
  scheduledMinutes: number;
  payableMinutes: number;
  hasPhysicalPunches: boolean;
  projectionType: "paid_leave_full" | "paid_leave_half_merged" | "paid_leave_half_only";
  warning: string | null;
};

type AttendanceAdminPayload = {
  workDate: string;
  dateFrom?: string;
  dateTo?: string;
  includeVoided?: boolean;
  devices: AttendanceDevice[];
  users: User[];
  punches: AttendancePunch[];
  paidLeaveDays?: PaidLeaveAttendanceDay[];
  dailyNotes?: {
    id: string;
    user_id: string;
    work_date: string;
    memo: string;
    updated_at: string;
  }[];
  bereavementDays?: {
    id: string;
    user_id: string;
    work_date: string;
  }[];
  monthlyChecks?: {
    id: string;
    check_month: string;
    user_id: string;
    checked_by: string | null;
    checked_at: string;
    note: string | null;
  }[];
  summary?: {
    total: number;
    active: number;
    voided: number;
    limit: number;
  };
};

type DocScannerLaborDocument = {
  id: string;
  source: "tsg" | "doc-scanner";
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  department: string | null;
  hireDate: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  docType: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  summary: string | null;
  importedAt: string;
  ocrStatus: string | null;
  sourceDocumentId: string | null;
  suggested: boolean;
  downloadUrl: string | null;
};

type DocScannerPickerMessage = {
  type: "tsg-docscanner-selection";
  documents: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string | null;
    docType: string | null;
    docDate: string | null;
    importedAt: string;
    counterpartyName: string | null;
    summary: string | null;
    bytes: ArrayBuffer;
  }>;
};

const DOC_SCANNER_LOCAL_BASE_URLS = [
  "http://192.168.110.200:3004",
  "http://127.0.0.1:3004",
];

type MonthlyAttendanceDraft = {
  work_date: string;
  clock_in_time: string;
  clock_out_time: string;
  memo: string;
  break_30: boolean;
  private_vehicle_place: string;
  private_vehicle_distance_km: string;
  paid_leave: PaidLeaveAttendanceDay | null;
  bereavement_leave: boolean;
};

type PayrollEmployee = {
  id: string;
  user_id: string | null;
  employee_code: string | null;
  display_name: string;
  real_name: string | null;
  kana: string | null;
  birth_date: string | null;
  hire_date: string | null;
  resigned_date: string | null;
  gender: string | null;
  department: string | null;
  work_style?: WorkStyle | null;
  basic_work_start?: string | null;
  basic_work_end?: string | null;
  basic_break_minutes?: number | null;
  employment_type: string;
  pay_type: string;
  payroll_status: string;
  user: {
    id: string;
    display_name: string;
    real_name?: string | null;
    picture_url?: string | null;
    department?: string | null;
    status?: string | null;
  } | null;
  workplace: {
    id: string;
    code: string;
    name: string;
    department?: string | null;
  } | null;
};

type PayrollUserOption = {
  id: string;
  display_name: string;
  real_name?: string | null;
  picture_url?: string | null;
  department?: string | null;
  status?: string | null;
};

type HRProfile = {
  phone?: string;
  email?: string;
  postal_code?: string;
  address?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  education_history?: string;
  work_history?: string;
  qualifications?: string;
  personal_statement?: string;
  resume_notes?: string;
  hiring_contact_email_content?: string;
  memo?: string;
  provisional_hire?: boolean;
  provisional_hire_date?: string | null;
  deleted_at?: string;
  delete_reason?: string;
};

type HRCoreDraft = {
  hire_date?: string;
  kana?: string;
  birth_date?: string;
  gender?: string;
  basic_work_start?: string;
  basic_work_end?: string;
  basic_break_minutes?: string;
};

type HRResumeDocument = {
  id: string;
  file_name: string;
  file_size: number;
  ocr_status: "pending" | "processing" | "completed" | "failed";
  ocr_model: string | null;
  ocr_error: string | null;
  extracted_data: {
    appliedFields?: string[];
    warnings?: string[];
  } | null;
  processed_at: string | null;
  created_at: string;
};

type HREmployee = PayrollEmployee & {
  hr_profile: HRProfile;
  is_hr_deleted: boolean;
  payroll_result_count: number;
  resume_document: HRResumeDocument | null;
};

type HREmployeesPayload = {
  employees: HREmployee[];
  users: PayrollUserOption[];
  summary: {
    total: number;
    active: number;
    retired: number;
    unlinked: number;
    deleted: number;
    withPayroll: number;
  };
};

type PayrollEmployeesPayload = {
  employees: PayrollEmployee[];
  users: PayrollUserOption[];
  summary: {
    total: number;
    withEmployeeCode: number;
    linkedUsers: number;
    codedAndLinked: number;
    active: number;
    retired: number;
    unlinked: number;
  };
};

type LaborCostMonthlySummary = {
  periodId: string;
  periodKey: string;
  payrollMonth: string;
  payrollKind: string;
  payrollKindLabel: string;
  payDate: string;
  resultCount: number;
  paymentTotal: number;
  deductionTotal: number;
  netPayment: number;
  allocationTotal: number;
};

type LaborCostOrganizationSummary = {
  organization: string;
  resultCount: number;
  paymentTotal: number;
  netPayment: number;
};

type LaborCostEmployeeSummary = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  organization: string;
  months: number;
  paymentTotal: number;
  netPayment: number;
};

type LaborCostDetail = {
  id: string;
  periodKey: string;
  payrollMonth: string;
  payrollKindLabel: string;
  employeeCode: string | null;
  employeeName: string;
  organization: string;
  paymentTotal: number;
  deductionTotal: number;
  netPayment: number;
};

type LaborCostsPayload = {
  summary: {
    periods: number;
    employees: number;
    resultCount: number;
    paymentTotal: number;
    netPayment: number;
    latestPeriodKey: string;
  };
  monthlySummary: LaborCostMonthlySummary[];
  organizationSummary: LaborCostOrganizationSummary[];
  employeeSummary: LaborCostEmployeeSummary[];
  details: LaborCostDetail[];
};

type PayrollCalculationProfile = {
  profileId: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  department: string | null;
  workStyle: WorkStyle | null;
  payrollStatus: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  calculationType: "hourly" | "monthly_fixed" | "monthly_with_overtime" | "officer_fixed" | "unknown";
  monthlyBaseAmount: number;
  hourlyRate: number;
  overtimeDivisor: number;
  scheduledMinutes: number;
  publicHolidaysPerMonth: number;
  verification: {
    calculated_taxable_payment?: number;
    source_taxable_payment?: number;
    delta?: number;
  };
  consistencyWarnings: string[];
  calculation: {
    taxablePaymentTotal: number;
    paymentTotal: number;
    deductionTotal: number;
    netPayment: number;
    baseAmount: number;
    overtimeAmount: number;
    taxableAdditions: number;
    attendance: {
      workDays: number;
      workMinutes: number;
      weekdaySaturdayOvertimeMinutes: number;
      sundayOvertimeMinutes: number;
    };
  };
};

type PayrollCalculationProfilesPayload = {
  attendanceMonth: string;
  attendanceMonthEnd: string;
  summary: {
    profiles: number;
    calculatedEmployees: number;
    taxablePaymentTotal: number;
    paymentTotal: number;
    deductionTotal: number;
    netPayment: number;
  };
  profiles: PayrollCalculationProfile[];
};

type LaborImportBatch = {
  id: string;
  source_root: string;
  payroll_kind: string;
  payrollKindLabel: string;
  target_attendance_month: string | null;
  target_payroll_month: string | null;
  period_start: string | null;
  period_end: string | null;
  pay_date: string | null;
  status: string;
  summary: Record<string, unknown> | null;
  imported_at: string;
  documentCount: number;
  extractedCount: number;
  imageOnlyCount: number;
  failedCount: number;
  totalFileSize: number;
};

type LaborSourceDocument = {
  id: string;
  import_batch_id: string | null;
  relative_path: string;
  file_name: string;
  file_extension: string;
  fileSize: number;
  document_type: string;
  target_attendance_month: string | null;
  target_payroll_month: string | null;
  extraction_status: string;
  extraction_notes: string | null;
  extracted_summary: Record<string, unknown> | null;
  created_at: string;
};

type LaborImportsPayload = {
  summary: {
    batches: number;
    documents: number;
    extracted: number;
    imageOnly: number;
    failed: number;
    totalFileSize: number;
  };
  statusSummary: Record<string, number>;
  typeSummary: Record<string, number>;
  batches: LaborImportBatch[];
  documents: LaborSourceDocument[];
};

type PayrollDiffPeriod = {
  id: string;
  payrollMonth: string;
  payrollKind: string;
  payrollKindLabel: string;
  attendanceMonth: string;
  payDate: string;
};

type PayrollDiffRow = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  department: string | null;
  hasLaborResult: boolean;
  hasProfile: boolean;
  workDays: number | null;
  workMinutes: number | null;
  attendanceSource: "punch" | "labor_result" | "labor_snapshot" | "none";
  calculationUnavailableReason: string | null;
  laborMatch: {
    matchedBy: string;
    matchedByLabel: string;
    confidence: number;
    sourceEmployeeId: string | null;
    sourceEmployeeCode: string | null;
    sourceEmployeeName: string;
  } | null;
  laborCandidates: {
    matchedBy: string;
    matchedByLabel: string;
    confidence: number;
    sourceEmployeeId: string | null;
    sourceEmployeeCode: string | null;
    sourceEmployeeName: string;
    paymentTotal: number;
    netPayment: number;
  }[];
  labor: {
    taxablePaymentTotal: number;
    nonTaxablePaymentTotal?: number;
    paymentTotal: number;
    deductionTotal: number;
    netPayment: number;
  } | null;
  calculated: {
    taxablePaymentTotal: number;
    nonTaxablePaymentTotal?: number;
    paymentTotal: number;
    deductionTotal: number;
    netPayment: number;
    baseAmount: number;
    overtimeAmount: number;
    taxableAdditions?: number;
  } | null;
  operational?: {
    workDays: number;
    workMinutes: number;
    overtimeMinutes: number;
    paymentTotal: number;
    deductionTotal: number;
    netPayment: number;
    paymentDelta: number | null;
    netDelta: number | null;
  } | null;
  hasOperationalAttendanceDifference?: boolean;
  operationalPaymentDelta?: number | null;
  attendanceDifferenceHints?: string[];
  laborBreakdown?: PayrollDiffBreakdown | null;
  calculatedBreakdown?: PayrollDiffBreakdown | null;
  differenceHints?: string[];
  delta: {
    paymentTotal: number | null;
    netPayment: number | null;
  };
  issue: string;
};

type PayrollDiffBreakdownItem = {
  code: string;
  label: string;
  amount: number;
  meta: string;
};

type PayrollDiffBreakdown = {
  baseAmount: number;
  overtimeAmount: number;
  taxableAdditions: number;
  nonTaxableAmount: number;
  deductionTotal: number;
  hasItemDetails: boolean;
  earningItems: PayrollDiffBreakdownItem[];
  deductionItems: PayrollDiffBreakdownItem[];
  attendanceItems: PayrollDiffBreakdownItem[];
};

type PayrollDiffPayload = {
  periods: PayrollDiffPeriod[];
  selectedPeriod: (PayrollDiffPeriod & { attendanceMonthEnd: string }) | null;
  requestedPeriodMissing?: boolean;
  summary: {
    employees: number;
    compared: number;
    missingProfile: number;
    missingLaborResult: number;
    autoMatchedLabor: number;
    matchCandidates: number;
    calculationUnavailable: number;
    paymentDeltaTotal: number;
    netDeltaTotal: number;
    mismatches: number;
  };
  review: {
    status: "not_ready" | "partially_blocked" | "needs_changes" | "verified";
    statusLabel: string;
    headline: string;
    readinessPercent: number;
    exactMatches: number;
    unresolvedEmployees: number;
    attendanceDifferenceEmployees?: number;
    blockerCategories: number;
    changeCandidateCategories: number;
    changePoints: {
      id: string;
      label: string;
      priority: "blocker" | "high" | "medium";
      diagnosis: string;
      action: string;
      target: string;
      affectedEmployees: number;
      employeeNames: string[];
      signedDeltaTotal: number;
      absoluteDeltaTotal: number;
    }[];
  };
  rows: PayrollDiffRow[];
};

type Tab = "users" | "groups" | "attendance" | "leave" | "shifts" | "pledges" | "payroll" | "hr" | "manual";
type WorkStyle = "regular_5d_8h" | "regular_6d_6_5h" | "part_time_under_29_5h" | "full_time_part" | "officer";

const WORK_STYLE_OPTIONS: { value: WorkStyle; label: string; detail: string }[] = [
  { value: "regular_5d_8h", label: "5日正社員", detail: "8時間 × 5日" },
  { value: "regular_6d_6_5h", label: "6日正社員", detail: "6.5時間 × 6日" },
  { value: "part_time_under_29_5h", label: "パート", detail: "週29.5時間以内" },
  { value: "full_time_part", label: "フルタイムパート", detail: "フルタイム" },
  { value: "officer", label: "役員", detail: "役員" },
];

const USER_DEPARTMENT_ORDER: Record<UserDepartment, number> = {
  フロア: 0,
  製造: 1,
  道の駅: 2,
};

function isAllStaffGroupName(name: string) {
  const normalized = name.replace(/\s+/g, "");
  return normalized.includes("オールスタッフ") || normalized.includes("全スタッフ");
}

function normalizePersonName(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, "").replace(/　+/g, "").trim();
}

function tsgDepartmentFromText(value: string | null | undefined): UserDepartment | null {
  if (!value) return null;
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment;
  if (value.includes("道の駅")) return "道の駅";
  if (value.includes("フロア") || value.includes("売上") || value.includes("ブランド館")) return "フロア";
  if (value.includes("製造") || value.includes("本社")) return "製造";
  return null;
}

function employeeTSGDepartment(employee: Pick<PayrollEmployee, "department" | "user" | "workplace">): UserDepartment {
  return (
    tsgDepartmentFromText(employee.user?.department) ||
    tsgDepartmentFromText(employee.department) ||
    tsgDepartmentFromText(employee.workplace?.department) ||
    tsgDepartmentFromText(employee.workplace?.name) ||
    DEFAULT_USER_DEPARTMENT
  );
}

function isCurrentEmployee(employee: HREmployee, currentUser: User | null) {
  if (!currentUser) return false;
  if (employee.user_id && employee.user_id === currentUser.id) return true;

  const currentNames = [
    normalizePersonName(currentUser.real_name),
    normalizePersonName(currentUser.display_name),
  ].filter(Boolean);
  const employeeNames = [
    normalizePersonName(employee.real_name),
    normalizePersonName(employee.display_name),
    normalizePersonName(employee.user?.real_name),
    normalizePersonName(employee.user?.display_name),
  ].filter(Boolean);

  return employeeNames.some((name) => currentNames.includes(name));
}

function compareHREmployees(a: HREmployee, b: HREmployee, currentUser: User | null) {
  const aIsCurrent = isCurrentEmployee(a, currentUser);
  const bIsCurrent = isCurrentEmployee(b, currentUser);
  if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;

  const departmentDiff = USER_DEPARTMENT_ORDER[employeeTSGDepartment(a)] - USER_DEPARTMENT_ORDER[employeeTSGDepartment(b)];
  if (departmentDiff !== 0) return departmentDiff;

  const aHire = a.hire_date ? new Date(a.hire_date).getTime() : Number.MAX_SAFE_INTEGER;
  const bHire = b.hire_date ? new Date(b.hire_date).getTime() : Number.MAX_SAFE_INTEGER;
  if (aHire !== bHire) return aHire - bHire;

  const codeDiff = (a.employee_code || "").localeCompare(b.employee_code || "", "ja", { numeric: true });
  if (codeDiff !== 0) return codeDiff;

  return (a.real_name || a.display_name).localeCompare(b.real_name || b.display_name, "ja");
}

function compareUsers(a: User, b: User, currentUser: User | null) {
  if (currentUser) {
    if (a.id === currentUser.id && b.id !== currentUser.id) return -1;
    if (b.id === currentUser.id && a.id !== currentUser.id) return 1;
  }

  const departmentDiff = USER_DEPARTMENT_ORDER[a.department || DEFAULT_USER_DEPARTMENT] - USER_DEPARTMENT_ORDER[b.department || DEFAULT_USER_DEPARTMENT];
  if (departmentDiff !== 0) return departmentDiff;

  const aCreated = a.created_at ? new Date(a.created_at).getTime() : Number.MAX_SAFE_INTEGER;
  const bCreated = b.created_at ? new Date(b.created_at).getTime() : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;

  return (a.real_name || a.display_name).localeCompare(b.real_name || b.display_name, "ja");
}

function Avatar({ user, size = 36 }: { user: { display_name: string; picture_url: string | null }; size?: number }) {
  return <SafeLineAvatar name={user.display_name} pictureUrl={user.picture_url} size={size} />;
}

function todayInputDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function monthInputDateRange(monthOffset: number) {
  const [year, month] = todayInputDate().split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const end = new Date(Date.UTC(year, month + monthOffset, 0));

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function currentInputTime() {
  return new Date().toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPunchTime(value: string) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function punchTimeInput(value: string) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function punchTypeLabel(value: "clock_in" | "clock_out") {
  return value === "clock_in" ? "出勤" : "退勤";
}

function monthInputValue() {
  return todayInputDate().slice(0, 7);
}

function monthRangeFromValue(value: string) {
  const [year, month] = value.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function datesInMonth(value: string) {
  const range = monthRangeFromValue(value);
  const dates: string[] = [];
  const current = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function weekdayLabel(value: string) {
  const date = new Date(`${value}T15:00:00Z`);
  return ["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()] || "";
}

const THIRTY_MINUTE_BREAK_NOTE = "30分休憩";

function stripThirtyMinuteBreakMemo(value: string | null | undefined, hasThirtyMinuteBreak: boolean) {
  const memo = (value || "").trim();
  if (!hasThirtyMinuteBreak) return memo;
  if (memo === THIRTY_MINUTE_BREAK_NOTE) return "";
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE} / `)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE} / `.length).trim();
  }
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE}\n`)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE}\n`.length).trim();
  }
  return memo;
}

function timeTextToMinutes(value: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function roundAttendanceMinutes(minutes: number, unit = 15) {
  return Math.round(minutes / unit) * unit;
}

function defaultAttendanceBreakMinutes(grossMinutes: number) {
  if (grossMinutes > 480) return 60;
  if (grossMinutes > 360) return 45;
  if (grossMinutes > 300) return 30;
  return 0;
}

function formatAttendanceMinutes(minutes: number | null) {
  if (minutes === null) return "-";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

function calculateMonthlyDraftWorkMinutes(draft: MonthlyAttendanceDraft) {
  const clockInMinutes = timeTextToMinutes(draft.clock_in_time);
  const clockOutMinutes = timeTextToMinutes(draft.clock_out_time);
  if (clockInMinutes === null || clockOutMinutes === null) {
    return null;
  }

  const rawMinutes = clockOutMinutes >= clockInMinutes
    ? clockOutMinutes - clockInMinutes
    : clockOutMinutes + 24 * 60 - clockInMinutes;
  const grossMinutes = roundAttendanceMinutes(rawMinutes);
  const breakMinutes = draft.break_30 ? 30 : defaultAttendanceBreakMinutes(grossMinutes);
  return Math.max(0, grossMinutes - breakMinutes);
}

function monthlyDraftSignature(draft: MonthlyAttendanceDraft) {
  return JSON.stringify({
    clock_in_time: draft.clock_in_time,
    clock_out_time: draft.clock_out_time,
    memo: draft.memo,
    break_30: draft.break_30,
    private_vehicle_place: draft.private_vehicle_place,
    private_vehicle_distance_km: draft.private_vehicle_distance_km,
  });
}

function buildMonthlyDraft(
  workDate: string,
  punches: AttendancePunch[],
  paidLeave: PaidLeaveAttendanceDay | null = null,
  dailyMemo: string | null = null,
  bereavementLeave = false,
): MonthlyAttendanceDraft {
  const clockIns = punches
    .filter((punch) => punch.punch_type === "clock_in" && !punch.is_voided)
    .sort((a, b) => a.punched_at.localeCompare(b.punched_at));
  const clockOuts = punches
    .filter((punch) => punch.punch_type === "clock_out" && !punch.is_voided)
    .sort((a, b) => b.punched_at.localeCompare(a.punched_at));
  const clockIn = clockIns[0] || null;
  const clockOut = clockOuts[0] || null;
  const hasThirtyMinuteBreak = clockOut?.break_override_minutes === 30 || clockIn?.break_override_minutes === 30;

  return {
    work_date: workDate,
    clock_in_time: paidLeave?.clockInTime || (clockIn ? punchTimeInput(clockIn.punched_at) : ""),
    clock_out_time: paidLeave?.clockOutTime || (clockOut ? punchTimeInput(clockOut.punched_at) : ""),
    memo: dailyMemo
      ?? (bereavementLeave ? "忌引き休" : stripThirtyMinuteBreakMemo(clockOut?.memo || clockIn?.memo || "", hasThirtyMinuteBreak)),
    break_30: paidLeave ? paidLeave.breakMinutes === 30 : hasThirtyMinuteBreak,
    private_vehicle_place: clockOut?.private_vehicle_place || "",
    private_vehicle_distance_km:
      clockOut?.private_vehicle_distance_km === null || clockOut?.private_vehicle_distance_km === undefined
        ? ""
        : String(clockOut.private_vehicle_distance_km),
    paid_leave: paidLeave,
    bereavement_leave: bereavementLeave,
  };
}

function formatOptionalDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function currentMonthInputValue(offsetMonths = 0) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatPayrollMonth(value: string, kindLabel?: string) {
  const date = new Date(value);
  const month = date.toLocaleDateString("ja-JP", { year: "numeric", month: "long" });
  return kindLabel ? `${month} ${kindLabel}` : month;
}

function formatLaborPayrollPeriod(
  attendanceMonth: string | null | undefined,
  payDate: string | null | undefined,
  payrollMonth: string | null | undefined,
  kindLabel = "給与",
) {
  const payrollMonthValue = payrollMonth?.slice(0, 7) || "";
  if (kindLabel !== "給与") {
    const base = payrollMonthValue ? formatPayrollMonth(`${payrollMonthValue}-01`, kindLabel) : kindLabel;
    if (!payDate) return base;
    const [, month, day] = payDate.slice(0, 10).split("-");
    return `${base} / ${Number(month)}月${Number(day)}日支給`;
  }

  const attendanceValue = attendanceMonth?.slice(0, 7) || "";
  const [year, month] = attendanceValue.split("-");
  const workLabel = year && month
    ? `${year}年${Number(month)}月勤務分`
    : payrollMonthValue
      ? `${formatPayrollMonth(`${payrollMonthValue}-01`)}支給分`
      : "給与期間未設定";
  if (!payDate) return workLabel;
  const [, payMonth, payDay] = payDate.slice(0, 10).split("-");
  return `${workLabel} / ${Number(payMonth)}月${Number(payDay)}日支給`;
}

function formatPayrollMinutes(value: number) {
  const minutes = Math.max(0, Math.round(value || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")}`;
}

function calculationTypeLabel(value: PayrollCalculationProfile["calculationType"]) {
  if (value === "hourly") return "時給";
  if (value === "monthly_with_overtime") return "月給＋残業";
  if (value === "monthly_fixed") return "月給固定";
  if (value === "officer_fixed") return "役員固定";
  return "未設定";
}

function payrollStatusLabel(value: string) {
  if (value === "active") return "在籍";
  if (value === "retired") return "退職";
  if (value === "inactive") return "停止";
  return value || "-";
}

function workStyleLabel(value?: string | null) {
  return WORK_STYLE_OPTIONS.find((option) => option.value === value)?.label || "未設定";
}

function departmentIcon(value: UserDepartment) {
  if (value === "フロア") return "🏠";
  if (value === "製造") return "⚙";
  return "🏪";
}

function extractionStatusLabel(value: string) {
  if (value === "extracted") return "抽出済";
  if (value === "partial") return "一部抽出";
  if (value === "image_only") return "画像原票";
  if (value === "failed") return "失敗";
  if (value === "pending") return "未処理";
  return value || "-";
}

function formatFileSize(value: number) {
  if (!value) return "-";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function resumeOcrStatusLabel(value: HRResumeDocument["ocr_status"]) {
  if (value === "completed") return "AI読取済み";
  if (value === "processing") return "AI読取中";
  if (value === "failed") return "AI読取失敗";
  return "AI読取待ち";
}

// ─── ユーザー管理タブ ───
function UsersTab({ currentUser }: { currentUser: User | null }) {
  const [users, setUsers] = useState<User[]>([]);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  function loadUsers() {
    setLoading(true);
    fetch("/api/admin/users")
      .then(r => r.ok ? r.json() : { users: [] })
      .then(d => {
        const nextUsers = d.users || [];
        setUsers(nextUsers);
        setNameDrafts(Object.fromEntries(nextUsers.map((nextUser: User) => [nextUser.id, nextUser.real_name || ""])));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadUsers(); }, []);

  async function handleRoleChange(userId: string, newRole: string) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role: newRole }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "権限の変更に失敗しました");
    }
  }

  async function handleDepartmentChange(userId: string, department: UserDepartment) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, department }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "部署の変更に失敗しました");
    }
  }

  async function handleStatusChange(userId: string, newStatus: User["status"]) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, status: newStatus }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "承認状態の変更に失敗しました");
    }
  }

  async function handleRealNameSave(user: User) {
    const nextName = (nameDrafts[user.id] || "").trim();
    if (nextName === (user.real_name || "")) return;

    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, real_name: nextName || null }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "本名の保存に失敗しました");
    }
  }

  async function handleDelete(user: User) {
    if (!confirm(`${user.display_name} を削除しますか？この操作は取り消せません。`)) return;
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "削除に失敗しました");
    }
  }

  if (loading) return <p className="admin-empty">読み込み中...</p>;

  const sortedUsers = [...users].sort((a, b) => compareUsers(a, b, currentUser));
  const currentUserIsExecutive = isExecutiveUser(currentUser);

  return (
    <div className="admin-list">
      {sortedUsers.map(user => (
        <div key={user.id} className="admin-item">
          <Avatar user={user} size={40} />
          <div className="admin-item__info">
            <div className="admin-item__name">
              {user.display_name}
              <UserRoleBadge user={user} />
            </div>
            <div className="admin-name-editor">
              <input
                type="text"
                className="form-input"
                placeholder="本名 (任意)"
                value={nameDrafts[user.id] ?? (user.real_name || "")}
                onChange={e => setNameDrafts(current => ({ ...current, [user.id]: e.target.value }))}
                disabled={isExecutiveUser(user) && !currentUserIsExecutive}
                onKeyDown={e => {
                  if (e.key === "Enter") handleRealNameSave(user);
                }}
                aria-label={`${user.display_name} の本名`}
              />
              <button
                type="button"
                className="admin-btn-outline"
                onClick={() => handleRealNameSave(user)}
                disabled={
                  (isExecutiveUser(user) && !currentUserIsExecutive)
                  || (nameDrafts[user.id] ?? (user.real_name || "")).trim() === (user.real_name || "")
                }
              >
                保存
              </button>
            </div>
            <div className="admin-item__sub">
              {new Date(user.created_at).toLocaleDateString("ja-JP")} 登録
              <span className={`admin-status admin-status--${user.status || "approved"}`}>
                {user.status === "pending" ? "承認待ち" : user.status === "suspended" ? "停止中" : "承認済み"}
              </span>
            </div>
          </div>
          <div className="admin-item__actions">
            {user.status === "pending" && (
              <button
                type="button"
                className="admin-btn-accent"
                onClick={() => handleStatusChange(user.id, "approved")}
                disabled={isExecutiveUser(user) && !currentUserIsExecutive}
              >
                承認
              </button>
            )}
            {user.status === "approved" && (
              <button
                type="button"
                className="admin-btn-outline"
                onClick={() => handleStatusChange(user.id, "suspended")}
                disabled={isExecutiveUser(user)}
              >
                停止
              </button>
            )}
            {user.status === "suspended" && (
              <button
                type="button"
                className="admin-btn-accent"
                onClick={() => handleStatusChange(user.id, "approved")}
                disabled={isExecutiveUser(user) && !currentUserIsExecutive}
              >
                再開
              </button>
            )}
            <select
              value={getEffectiveUserRole(user)}
              onChange={e => handleRoleChange(user.id, e.target.value)}
              className="admin-select"
              aria-label={`${user.display_name} の権限`}
              disabled={isExecutiveUser(user)}
            >
              {USER_ROLE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={user.department || DEFAULT_USER_DEPARTMENT}
              onChange={e => handleDepartmentChange(user.id, e.target.value as UserDepartment)}
              className="admin-select"
              aria-label={`${user.display_name} の部署`}
              disabled={isExecutiveUser(user) && !currentUserIsExecutive}
            >
              {USER_DEPARTMENTS.map(department => (
                <option key={department} value={department}>{department}</option>
              ))}
            </select>
            <button
              type="button"
              className="admin-btn-danger"
              onClick={() => handleDelete(user)}
              title={isExecutiveUser(user) ? "役員アカウントは削除できません" : "削除"}
              disabled={isExecutiveUser(user)}
            >
              🗑
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── グループ管理タブ ───
function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [nonMembers, setNonMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupType, setNewGroupType] = useState<"board" | "chat">("board");
  const [newGroupIcon, setNewGroupIcon] = useState("📢");
  const [newGroupAddAllMembers, setNewGroupAddAllMembers] = useState(false);
  const [creating, setCreating] = useState(false);

  function loadGroups() {
    setLoading(true);
    fetch("/api/admin/groups")
      .then(r => r.ok ? r.json() : { groups: [] })
      .then(d => setGroups(d.groups))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadGroups(); }, []);

  async function loadMembers(group: Group) {
    setSelectedGroup(group);
    setMembersLoading(true);
    const res = await fetch(`/api/admin/members?group_id=${group.id}`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members || []);
      setNonMembers(data.nonMembers || []);
    }
    setMembersLoading(false);
  }

  async function handleDeleteGroup(group: Group) {
    if (!confirm(`「${group.name}」を削除しますか？投稿もすべて削除されます。`)) return;
    const res = await fetch("/api/admin/groups", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: group.id }),
    });
    if (res.ok) {
      setSelectedGroup(null);
      loadGroups();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "グループの削除に失敗しました");
    }
  }

  async function handleAddMember(userId: string) {
    if (!selectedGroup) return;
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_ids: [userId] }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("メンバーの追加に失敗しました");
  }

  async function handleAddAllMembers() {
    if (!selectedGroup || nonMembers.length === 0) return;
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_ids: nonMembers.map(u => u.id) }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("メンバーの追加に失敗しました");
  }

  async function handleAddDepartmentMembers(department: UserDepartment) {
    if (!selectedGroup) return;
    const targetMembers = nonMembers.filter(user => (user.department || DEFAULT_USER_DEPARTMENT) === department);
    if (targetMembers.length === 0) return;
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_ids: targetMembers.map(user => user.id) }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("部署メンバーの追加に失敗しました");
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedGroup) return;
    const res = await fetch("/api/admin/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_id: userId }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "メンバーの削除に失敗しました");
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newGroupName.trim(),
        type: newGroupType,
        icon: newGroupIcon,
        add_all_members: newGroupAddAllMembers,
      }),
    });
    if (res.ok) {
      setNewGroupName("");
      setNewGroupAddAllMembers(false);
      setShowCreate(false);
      loadGroups();
    } else alert("グループの作成に失敗しました");
    setCreating(false);
  }

  const icons = ["📢", "💻", "💬", "📋", "🎯", "🏠", "📦", "🔧", "📊", "🎨"];

  function openCreateForm(type: "board" | "chat") {
    setNewGroupType(type);
    setNewGroupIcon(type === "chat" ? "💬" : "📢");
    setNewGroupAddAllMembers(false);
    setShowCreate(true);
  }

  if (loading) return <p className="admin-empty">読み込み中...</p>;

  // メンバー管理画面
  if (selectedGroup) {
    return (
      <div>
        <button type="button" className="admin-back-btn" onClick={() => setSelectedGroup(null)}>
          ← グループ一覧に戻る
        </button>
        <div className="admin-section-header">
          <span style={{ fontSize: 24 }}>{selectedGroup.icon}</span>
          <h3 className="admin-section-title">{selectedGroup.name}</h3>
          <button
            type="button"
            className="admin-btn-danger"
            onClick={() => handleDeleteGroup(selectedGroup)}
            style={{ marginLeft: "auto" }}
          >
            🗑 削除
          </button>
        </div>

        {membersLoading ? (
          <p className="admin-empty">読み込み中...</p>
        ) : (
          <>
            {/* 参加中メンバー */}
            <h4 className="admin-sub-title">
              参加中 ({members.length})
            </h4>
            <div className="admin-list">
              {members.length === 0 ? (
                <p className="admin-empty">メンバーがいません</p>
              ) : (
                members.map(m => (
                  <div key={m.id} className="admin-item">
                    <Avatar user={m} size={34} />
                    <div className="admin-item__info">
                      <div className="admin-item__name">{m.display_name}</div>
                      <div className="admin-item__sub">
                        {m.group_role === "admin" ? "グループ管理者" : "メンバー"}
                        {isManagementRole(getEffectiveUserRole(m)) ? `・${getUserRoleLabel(m)}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="admin-btn-outline"
                      onClick={() => handleRemoveMember(m.id)}
                    >
                      除外
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* 未参加ユーザー */}
            <h4 className="admin-sub-title" style={{ marginTop: 16 }}>
              未参加 ({nonMembers.length})
              {nonMembers.length > 0 && (
                <button type="button" className="admin-btn-small" onClick={handleAddAllMembers}>
                  全員追加
                </button>
              )}
            </h4>
            <div className="admin-list">
              {nonMembers.length > 0 && (
                <div className="admin-create-actions" style={{ marginBottom: 10 }}>
                  {USER_DEPARTMENTS.map(department => {
                    const count = nonMembers.filter(user => (user.department || DEFAULT_USER_DEPARTMENT) === department).length;
                    return (
                      <button
                        key={department}
                        type="button"
                        className="admin-btn-small"
                        onClick={() => handleAddDepartmentMembers(department)}
                        disabled={count === 0}
                      >
                        {department}を追加 ({count})
                      </button>
                    );
                  })}
                </div>
              )}
              {nonMembers.length === 0 ? (
                <p className="admin-empty">全員が参加しています</p>
              ) : (
                nonMembers.map(u => (
                  <div key={u.id} className="admin-item">
                    <Avatar user={u} size={34} />
                    <div className="admin-item__info">
                      <div className="admin-item__name">{u.display_name}</div>
                      <div className="admin-item__sub"><UserRoleBadge user={u} /></div>
                    </div>
                    <button
                      type="button"
                      className="admin-btn-accent"
                      onClick={() => handleAddMember(u.id)}
                    >
                      追加
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // グループ一覧
  return (
    <div>
      <div className="admin-create-actions">
        <button type="button" className="admin-create-btn" onClick={() => openCreateForm("board")}>
          ＋ 掲示板を作成
        </button>
        <button type="button" className="admin-create-btn admin-create-btn--chat" onClick={() => openCreateForm("chat")}>
          ＋ Chatを作成
        </button>
      </div>

      {showCreate && (
        <form className="admin-create-form" onSubmit={handleCreateGroup}>
          <div className="admin-create-form__title">
            {newGroupType === "chat" ? "新規Chat作成" : "新規掲示板作成"}
          </div>
          <input
            type="text"
            className="form-input"
            value={newGroupName}
            onChange={e => {
              const nextName = e.target.value;
              setNewGroupName(nextName);
              if (isAllStaffGroupName(nextName)) setNewGroupAddAllMembers(true);
            }}
            placeholder={newGroupType === "chat" ? "Chat名" : "掲示板名"}
            autoFocus
          />
          <div className="type-selector" style={{ marginTop: 8 }}>
            <button type="button" className={`type-btn ${newGroupType === "board" ? "type-btn--active" : ""}`} onClick={() => setNewGroupType("board")}>📋 掲示板</button>
            <button type="button" className={`type-btn ${newGroupType === "chat" ? "type-btn--active" : ""}`} onClick={() => setNewGroupType("chat")}>💬 チャット</button>
          </div>
          {newGroupType === "board" && (
            <div className="icon-grid" style={{ marginTop: 8 }}>
              {icons.map(ic => (
                <button key={ic} type="button" className={`icon-select-btn ${newGroupIcon === ic ? "icon-select-btn--active" : ""}`} onClick={() => setNewGroupIcon(ic)}>{ic}</button>
              ))}
            </div>
          )}
          <label className="form-check" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={newGroupAddAllMembers}
              onChange={e => setNewGroupAddAllMembers(e.target.checked)}
            />
            <span>承認済みスタッフ全員をメンバーに追加</span>
          </label>
          <div className="admin-form-actions">
            <button type="button" className="btn-cancel" onClick={() => setShowCreate(false)}>キャンセル</button>
            <button type="submit" className="btn-primary" disabled={creating || !newGroupName.trim()}>
              {creating ? "作成中..." : "作成"}
            </button>
          </div>
        </form>
      )}

      <div className="admin-list" style={{ marginTop: showCreate ? 16 : 0 }}>
        {groups.length === 0 ? (
          <p className="admin-empty">グループがありません</p>
        ) : (
          groups.map(group => {
            const groupType = group.type === "chat" ? "chat" : "board";
            return (
            <div key={group.id} className={`admin-item admin-item--clickable admin-group-card admin-group-card--${groupType}`} onClick={() => loadMembers(group)}>
              <div className={`group-card__icon group-card__icon--${groupType}`} style={{ width: 40, height: 40, borderRadius: 10, fontSize: 20 }}>
                {group.icon}
              </div>
              <div className="admin-item__info">
                <div className="admin-item__name">{group.name}</div>
                <div className="admin-item__sub">{group.type === "board" ? "掲示板" : "チャット"}</div>
              </div>
              <span className="admin-group-card__manage">メンバー管理 →</span>
            </div>
          )})
        )}
      </div>
    </div>
  );
}

// ─── 勤怠管理タブ ───
function AttendanceAdminTab({ currentUser }: { currentUser: User | null }) {
  const [data, setData] = useState<AttendanceAdminPayload | null>(null);
  const [workDate, setWorkDate] = useState(todayInputDate());
  const [dateFrom, setDateFrom] = useState(todayInputDate());
  const [dateTo, setDateTo] = useState(todayInputDate());
  const [attendanceUserFilter, setAttendanceUserFilter] = useState("");
  const [attendanceDeviceFilter, setAttendanceDeviceFilter] = useState("");
  const [includeVoidedPunches, setIncludeVoidedPunches] = useState(false);
  const [selectedPunchIds, setSelectedPunchIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [origin, setOrigin] = useState("");
  const [manualUserId, setManualUserId] = useState("");
  const [manualDeviceId, setManualDeviceId] = useState("");
  const [manualPunchType, setManualPunchType] = useState<"clock_in" | "clock_out">("clock_in");
  const [manualTime, setManualTime] = useState(currentInputTime());
  const [manualMemo, setManualMemo] = useState("");
  const [manualPrivateVehiclePlace, setManualPrivateVehiclePlace] = useState("");
  const [manualPrivateVehicleDistanceKm, setManualPrivateVehicleDistanceKm] = useState("");
  const [manualThirtyMinuteBreak, setManualThirtyMinuteBreak] = useState(false);
  const [editingPunchId, setEditingPunchId] = useState<string | null>(null);
  const [editUserId, setEditUserId] = useState("");
  const [editDeviceId, setEditDeviceId] = useState("");
  const [editPunchType, setEditPunchType] = useState<"clock_in" | "clock_out">("clock_in");
  const [editWorkDate, setEditWorkDate] = useState(workDate);
  const [editTime, setEditTime] = useState(currentInputTime());
  const [editMemo, setEditMemo] = useState("");
  const [editPrivateVehiclePlace, setEditPrivateVehiclePlace] = useState("");
  const [editPrivateVehicleDistanceKm, setEditPrivateVehicleDistanceKm] = useState("");
  const [editThirtyMinuteBreak, setEditThirtyMinuteBreak] = useState(false);
  const [monthlyData, setMonthlyData] = useState<AttendanceAdminPayload | null>(null);
  const [monthlyMonth, setMonthlyMonth] = useState(monthInputValue());
  const [monthlyDepartment, setMonthlyDepartment] = useState<UserDepartment>(currentUser?.department || DEFAULT_USER_DEPARTMENT);
  const [monthlyUserId, setMonthlyUserId] = useState("");
  const [monthlyDrafts, setMonthlyDrafts] = useState<Record<string, MonthlyAttendanceDraft>>({});
  const [monthlyBaseline, setMonthlyBaseline] = useState<Record<string, string>>({});
  const [monthlyLoading, setMonthlyLoading] = useState(true);
  const [monthlySaving, setMonthlySaving] = useState(false);
  const [monthlyDeletingDate, setMonthlyDeletingDate] = useState<string | null>(null);
  const [monthlyCheckedUserIds, setMonthlyCheckedUserIds] = useState<string[]>([]);
  const [monthlySubmitting, setMonthlySubmitting] = useState(false);
  const [monthlyLaborAttachments, setMonthlyLaborAttachments] = useState<File[]>([]);
  const monthlyLaborAttachmentInputRef = useRef<HTMLInputElement>(null);
  const [monthlyDocScannerDocuments, setMonthlyDocScannerDocuments] = useState<DocScannerLaborDocument[]>([]);
  const [monthlySelectedDocScannerIds, setMonthlySelectedDocScannerIds] = useState<string[]>([]);
  const [monthlyDocScannerDraftIds, setMonthlyDocScannerDraftIds] = useState<string[]>([]);
  const [monthlyDocScannerLoading, setMonthlyDocScannerLoading] = useState(false);
  const [monthlyDocScannerError, setMonthlyDocScannerError] = useState("");
  const [monthlyDocScannerPickerOpen, setMonthlyDocScannerPickerOpen] = useState(false);
  const [monthlyDocScannerSearch, setMonthlyDocScannerSearch] = useState("");
  const [monthlyDocScannerFiles, setMonthlyDocScannerFiles] = useState<Record<string, File>>({});

  useEffect(() => {
    function receiveDocScannerSelection(event: MessageEvent<unknown>) {
      if (!DOC_SCANNER_LOCAL_BASE_URLS.includes(event.origin)) return;
      const message = event.data as Partial<DocScannerPickerMessage> | null;
      if (message?.type !== "tsg-docscanner-selection" || !Array.isArray(message.documents)) return;

      const nextFiles: Record<string, File> = {};
      const nextDocuments = message.documents.flatMap((document) => {
        if (!document?.id || !document.fileName || !(document.bytes instanceof ArrayBuffer)) return [];
        const id = `doc-scanner:${document.id}`;
        nextFiles[id] = new File([document.bytes], document.fileName, {
          type: document.mimeType || "application/octet-stream",
        });
        return [{
          id,
          source: "doc-scanner" as const,
          employeeId: null,
          employeeCode: null,
          employeeName: null,
          department: null,
          hireDate: null,
          fileName: document.fileName,
          fileSize: Number(document.fileSize || document.bytes.byteLength),
          mimeType: document.mimeType,
          docType: document.docType,
          docDate: document.docDate,
          counterpartyName: document.counterpartyName,
          summary: document.summary,
          importedAt: document.importedAt,
          ocrStatus: null,
          sourceDocumentId: document.id,
          suggested: false,
          downloadUrl: null,
        } satisfies DocScannerLaborDocument];
      });

      if (nextDocuments.length === 0) return;
      setMonthlyDocScannerDocuments((documents) => [
        ...nextDocuments,
        ...documents.filter((document) => document.source === "tsg"),
      ]);
      setMonthlyDocScannerFiles(nextFiles);
      setMonthlySelectedDocScannerIds(nextDocuments.map((document) => document.id));
      setMonthlyDocScannerDraftIds(nextDocuments.map((document) => document.id));
      setMonthlyDocScannerPickerOpen(false);
      setMonthlyDocScannerError("");
    }

    window.addEventListener("message", receiveDocScannerSelection);
    return () => window.removeEventListener("message", receiveDocScannerSelection);
  }, []);

  function terminalUrl(device: AttendanceDevice) {
    return `${origin || ""}/time-clock/${device.device_key}`;
  }

  function terminalQrUrl(device: AttendanceDevice) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=168x168&margin=10&data=${encodeURIComponent(terminalUrl(device))}`;
  }

  function loadAttendance(
    nextDateFrom = dateFrom,
    nextDateTo = dateTo,
    nextIncludeVoided = includeVoidedPunches,
    nextUserFilter = attendanceUserFilter,
    nextDeviceFilter = attendanceDeviceFilter,
  ) {
    setLoading(true);
    const params = new URLSearchParams({
      date_from: nextDateFrom,
      date_to: nextDateTo,
      include_voided: nextIncludeVoided ? "1" : "0",
    });
    if (nextUserFilter) params.set("user_id", nextUserFilter);
    if (nextDeviceFilter) params.set("device_id", nextDeviceFilter);

    fetch(`/api/admin/attendance?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((payload: AttendanceAdminPayload) => {
        setData(payload);
        setSelectedPunchIds([]);
        if (!manualUserId && payload.users[0]) setManualUserId(payload.users[0].id);
        if (!manualDeviceId && payload.devices[0]) setManualDeviceId(payload.devices[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  function loadMonthlyAttendance(
    nextMonth = monthlyMonth,
    nextDepartment = monthlyDepartment,
    nextUserId = monthlyUserId,
  ) {
    setMonthlyLoading(true);
    const range = monthRangeFromValue(nextMonth);
    const params = new URLSearchParams({
      date_from: range.from,
      date_to: range.to,
      include_voided: "0",
    });

    fetch(`/api/admin/attendance?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((payload: AttendanceAdminPayload) => {
        setMonthlyData(payload);
        setMonthlyCheckedUserIds((payload.monthlyChecks || []).map((check) => check.user_id));
        const departmentUsers = payload.users.filter((user) => user.department === nextDepartment);
        const nextSelectedUserId = nextUserId && departmentUsers.some((user) => user.id === nextUserId)
          ? nextUserId
          : departmentUsers[0]?.id || "";
        setMonthlyUserId(nextSelectedUserId);
      })
      .catch(() => setMonthlyData(null))
      .finally(() => setMonthlyLoading(false));
  }

  async function loadMonthlyDocScannerDocuments(nextMonth = monthlyMonth) {
    setMonthlyDocScannerLoading(true);
    setMonthlyDocScannerError("");
    try {
      const storedResponse = await fetch(`/api/admin/attendance/submit?month=${encodeURIComponent(nextMonth)}`, {
        cache: "no-store",
      });
      const storedPayload = await storedResponse.json().catch(() => ({}));
      const storedDocuments = storedResponse.ok
        ? ((storedPayload.documents || []) as DocScannerLaborDocument[]).map((document) => ({
            ...document,
            source: "tsg" as const,
            mimeType: document.mimeType || "application/pdf",
            docType: document.docType || "resume",
            docDate: document.docDate || null,
            counterpartyName: document.counterpartyName || null,
            summary: document.summary || null,
            downloadUrl: null,
          }))
        : [];

      let localDocuments: DocScannerLaborDocument[] = [];
      let localError = "";
      for (const baseUrl of DOC_SCANNER_LOCAL_BASE_URLS) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch(`${baseUrl}/api/tsg/labor-documents?limit=100`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
          localDocuments = ((payload.documents || []) as Array<{
            id: string;
            fileName: string;
            fileSize: number;
            mimeType: string | null;
            docType: string | null;
            docDate: string | null;
            importedAt: string;
            counterpartyName: string | null;
            summary: string | null;
          }>).map((document) => ({
            id: `doc-scanner:${document.id}`,
            source: "doc-scanner" as const,
            employeeId: null,
            employeeCode: null,
            employeeName: null,
            department: null,
            hireDate: null,
            fileName: document.fileName,
            fileSize: Number(document.fileSize || 0),
            mimeType: document.mimeType,
            docType: document.docType,
            docDate: document.docDate,
            counterpartyName: document.counterpartyName,
            summary: document.summary,
            importedAt: document.importedAt,
            ocrStatus: null,
            sourceDocumentId: document.id,
            suggested: false,
            downloadUrl: `${baseUrl}/api/tsg/labor-documents/${encodeURIComponent(document.id)}/file`,
          }));
          localError = "";
          break;
        } catch (error) {
          localError = error instanceof Error ? error.message : "DocScanner本体へ接続できませんでした";
        } finally {
          window.clearTimeout(timeoutId);
        }
      }

      const localSourceIds = new Set(localDocuments.map((document) => document.sourceDocumentId).filter(Boolean));
      const documents = [
        ...localDocuments,
        ...storedDocuments.filter((document) => !document.sourceDocumentId || !localSourceIds.has(document.sourceDocumentId)),
      ];
      setMonthlyDocScannerDocuments(documents);
      if (documents.length === 0) {
        throw new Error(localError || storedPayload.error || "DocScanner書類を読み込めませんでした");
      }
    } catch (error) {
      setMonthlyDocScannerDocuments([]);
      setMonthlyDocScannerError(
        error instanceof Error
          ? `${error.message}。このPCでDocScannerを起動してから再読み込みしてください。`
          : "DocScanner書類を読み込めませんでした",
      );
    } finally {
      setMonthlyDocScannerLoading(false);
    }
  }

  function openMonthlyDocScannerPicker() {
    const pickerUrl = `${DOC_SCANNER_LOCAL_BASE_URLS[0]}/tsg-labor-picker?targetOrigin=${encodeURIComponent(window.location.origin)}`;
    const popup = window.open(
      pickerUrl,
      "tsg-docscanner-labor-picker",
      "popup=yes,width=920,height=760,resizable=yes,scrollbars=yes",
    );
    if (popup) {
      popup.focus();
      return;
    }

    setMonthlyDocScannerDraftIds(monthlySelectedDocScannerIds);
    setMonthlyDocScannerSearch("");
    setMonthlyDocScannerPickerOpen(true);
    loadMonthlyDocScannerDocuments();
  }

  function closeMonthlyDocScannerPicker() {
    setMonthlyDocScannerPickerOpen(false);
    setMonthlyDocScannerDraftIds([]);
    setMonthlyDocScannerSearch("");
  }

  function confirmMonthlyDocScannerSelection() {
    setMonthlySelectedDocScannerIds(monthlyDocScannerDraftIds);
    setMonthlyDocScannerPickerOpen(false);
    setMonthlyDocScannerSearch("");
  }

  function rebuildMonthlyDrafts(payload = monthlyData, userId = monthlyUserId, month = monthlyMonth) {
    if (!payload || !userId) {
      setMonthlyDrafts({});
      setMonthlyBaseline({});
      return;
    }

    const nextDrafts: Record<string, MonthlyAttendanceDraft> = {};
    const nextBaseline: Record<string, string> = {};
    for (const date of datesInMonth(month)) {
      const dayPunches = payload.punches.filter((punch) => punch.user_id === userId && punch.work_date === date);
      const paidLeave = (payload.paidLeaveDays || []).find(
        (day) => day.userId === userId && day.workDate === date,
      ) || null;
      const dailyMemo = (payload.dailyNotes || []).find(
        (note) => note.user_id === userId && note.work_date === date,
      )?.memo ?? null;
      const bereavementLeave = (payload.bereavementDays || []).some(
        (day) => day.user_id === userId && day.work_date === date,
      );
      const draft = buildMonthlyDraft(date, dayPunches, paidLeave, dailyMemo, bereavementLeave);
      nextDrafts[date] = draft;
      nextBaseline[date] = monthlyDraftSignature(draft);
    }
    setMonthlyDrafts(nextDrafts);
    setMonthlyBaseline(nextBaseline);
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    loadAttendance();
    loadMonthlyAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rebuildMonthlyDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthlyData, monthlyUserId, monthlyMonth]);

  function handleDatePreset(range: "today" | "currentMonth" | "previousMonth") {
    const today = todayInputDate();
    const nextRange = range === "today"
      ? { from: today, to: today }
      : monthInputDateRange(range === "currentMonth" ? 0 : -1);

    setDateFrom(nextRange.from);
    setDateTo(nextRange.to);
    setWorkDate(nextRange.from);
    loadAttendance(nextRange.from, nextRange.to, includeVoidedPunches, attendanceUserFilter, attendanceDeviceFilter);
  }

  function handleMonthlyMonthChange(value: string) {
    setMonthlyMonth(value);
    setMonthlySelectedDocScannerIds([]);
    setMonthlyDocScannerDraftIds([]);
    setMonthlyDocScannerDocuments([]);
    setMonthlyDocScannerError("");
    setMonthlyDocScannerPickerOpen(false);
    loadMonthlyAttendance(value, monthlyDepartment, monthlyUserId);
  }

  function handleMonthlyDepartmentChange(department: UserDepartment) {
    setMonthlyDepartment(department);
    loadMonthlyAttendance(monthlyMonth, department, "");
  }

  function updateMonthlyDraft(date: string, changes: Partial<MonthlyAttendanceDraft>) {
    setMonthlyDrafts((current) => ({
      ...current,
      [date]: {
        ...current[date],
        ...changes,
      },
    }));
  }

  function changedMonthlyDates() {
    return datesInMonth(monthlyMonth).filter((date) => {
      const draft = monthlyDrafts[date];
      return draft && monthlyDraftSignature(draft) !== monthlyBaseline[date];
    });
  }

  async function saveMonthlyDraft(date: string) {
    const draft = monthlyDrafts[date];
    if (!draft || !monthlyUserId) return false;
    if (draft.paid_leave || draft.bereavement_leave) return true;

    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "monthly_day_update",
        user_id: monthlyUserId,
        work_date: date,
        clock_in_time: draft.clock_in_time,
        clock_out_time: draft.clock_out_time,
        memo: draft.memo,
        break_override_minutes: draft.break_30 ? 30 : null,
        private_vehicle_place: draft.private_vehicle_place,
        private_vehicle_distance_km: draft.private_vehicle_distance_km,
      }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "月次勤怠修正に失敗しました");
      return false;
    }

    return true;
  }

  async function handleSaveMonthlyDay(date: string) {
    if (monthlySaving) return;
    setMonthlySaving(true);
    const ok = await saveMonthlyDraft(date);
    if (ok) loadMonthlyAttendance(monthlyMonth, monthlyDepartment, monthlyUserId);
    setMonthlySaving(false);
  }

  async function handleSaveMonthlyAll() {
    const dates = changedMonthlyDates();
    if (dates.length === 0 || monthlySaving) return;
    setMonthlySaving(true);
    for (const date of dates) {
      const ok = await saveMonthlyDraft(date);
      if (!ok) {
        setMonthlySaving(false);
        return;
      }
    }
    loadMonthlyAttendance(monthlyMonth, monthlyDepartment, monthlyUserId);
    setMonthlySaving(false);
  }

  async function handleDeleteMonthlyDay(date: string) {
    if (!monthlyUserId || monthlySaving || monthlyDeletingDate) return;
    const userName = selectedMonthlyUser?.real_name || selectedMonthlyUser?.display_name || "選択中スタッフ";
    if (!confirm(`${userName} の ${date} の勤怠データを削除しますか？\n給与計算対象から外れますが、履歴は残ります。`)) return;

    setMonthlyDeletingDate(date);
    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "monthly_day_delete",
        user_id: monthlyUserId,
        work_date: date,
        reason: "月次勤怠修正で日別削除",
      }),
    });

    if (res.ok) {
      loadMonthlyAttendance(monthlyMonth, monthlyDepartment, monthlyUserId);
      loadAttendance();
    } else {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "日別勤怠データの削除に失敗しました");
    }
    setMonthlyDeletingDate(null);
  }

  function downloadMonthlyExcel(department: UserDepartment) {
    const params = new URLSearchParams({
      month: monthlyMonth,
      department,
    });
    window.location.href = `/api/admin/attendance/export?${params.toString()}`;
  }

  async function toggleMonthlyStaffChecked(userId: string) {
    const isChecked = monthlyCheckedUserIds.includes(userId);
    if (!isChecked && userId === monthlyUserId && monthlyChangedDates.length > 0) {
      alert("未保存の変更があります。先に保存してからチェック完了にしてください。");
      return;
    }
    const previousIds = monthlyCheckedUserIds;
    const nextIds =
      isChecked
        ? monthlyCheckedUserIds.filter((id) => id !== userId)
        : [...monthlyCheckedUserIds, userId];
    setMonthlyCheckedUserIds(Array.from(new Set(nextIds)));

    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "monthly_staff_check",
        month: monthlyMonth,
        user_id: userId,
        checked: !isChecked,
      }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setMonthlyCheckedUserIds(previousIds);
      alert(payload.error || "チェック状態の保存に失敗しました");
    }
  }

  async function handleSubmitMonthlyToLaborOffice() {
    if (monthlySubmitting) return;
    if (!monthlyAllChecked) {
      alert(`未チェックのスタッフがいます。全員チェック済みにしてから送付してください。\n未チェック: ${monthlyTotalUsers - monthlyCheckedCount}名`);
      return;
    }

    setMonthlySubmitting(true);
    try {
      const formData = new FormData();
      formData.append("month", monthlyMonth);
      const selectedDocScannerDocuments = monthlyDocScannerDocuments.filter((document) => (
        monthlySelectedDocScannerIds.includes(document.id)
      ));
      const storedDocumentIds = selectedDocScannerDocuments
        .filter((document) => document.source === "tsg")
        .map((document) => document.id);
      formData.append("doc_scanner_document_ids", JSON.stringify(storedDocumentIds));

      for (const document of selectedDocScannerDocuments.filter((item) => item.source === "doc-scanner")) {
        const selectedFile = monthlyDocScannerFiles[document.id];
        if (selectedFile) {
          formData.append("doc_scanner_files", selectedFile);
          continue;
        }
        if (!document.downloadUrl) throw new Error(`${document.fileName} の取得データがありません。書類一覧から選び直してください。`);
        const response = await fetch(document.downloadUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`${document.fileName} をDocScannerから取得できませんでした`);
        const blob = await response.blob();
        formData.append(
          "doc_scanner_files",
          new File([blob], document.fileName, { type: document.mimeType || blob.type || "application/octet-stream" }),
        );
      }
      monthlyLaborAttachments.forEach((file) => formData.append("new_employee_files", file));
      const res = await fetch("/api/admin/attendance/submit", {
        method: "POST",
        body: formData,
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        alert(`${payload.error || "労務士提出データの送信に失敗しました"}\n労務士へは届いていません。必要な場合は予備Excelをダウンロードして送付してください。`);
        return;
      }

      const totalEmployeeFiles = monthlySelectedDocScannerIds.length + monthlyLaborAttachments.length;
      const attachmentMessage = totalEmployeeFiles > 0
        ? `\n新入社員情報 ${totalEmployeeFiles}件も添付しました。`
        : "";
      alert(`労務士へ勤怠データを送信しました。${attachmentMessage}`);
      setMonthlySelectedDocScannerIds([]);
      setMonthlyDocScannerDraftIds([]);
      setMonthlyDocScannerFiles({});
      setMonthlyLaborAttachments([]);
      if (monthlyLaborAttachmentInputRef.current) monthlyLaborAttachmentInputRef.current.value = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "通信エラーが発生しました";
      alert(`${message}\n労務士へは届いていません。必要な場合は予備Excelをダウンロードして送付してください。`);
    } finally {
      setMonthlySubmitting(false);
    }
  }

  function handleMonthlyLaborAttachmentChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    const allowedExtensions = new Set([
      "pdf", "png", "jpg", "jpeg", "webp", "heic", "heif",
      "doc", "docx", "xls", "xlsx", "xlsm", "csv", "txt", "zip",
    ]);
    const invalidFile = selectedFiles.find((file) => {
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      return !allowedExtensions.has(extension);
    });
    if (invalidFile) {
      alert(`${invalidFile.name} は添付できない形式です。PDF・画像・Word・Excel・CSV・TXT・ZIPを選択してください。`);
      return;
    }

    const nextFiles = [...monthlyLaborAttachments, ...selectedFiles];
    if (nextFiles.length > 6) {
      alert("新入社員情報は最大6ファイルまで添付できます。");
      return;
    }
    const totalBytes = nextFiles.reduce((total, file) => total + file.size, 0);
    if (totalBytes > 3_500_000) {
      alert("追加資料の合計サイズは3.5MB以内にしてください。");
      return;
    }
    setMonthlyLaborAttachments(nextFiles);
  }

  function removeMonthlyLaborAttachment(index: number) {
    setMonthlyLaborAttachments((files) => files.filter((_, fileIndex) => fileIndex !== index));
  }

  function toggleMonthlyDocScannerDocument(document: DocScannerLaborDocument) {
    const selected = monthlyDocScannerDraftIds.includes(document.id);
    if (selected) {
      setMonthlyDocScannerDraftIds((ids) => ids.filter((id) => id !== document.id));
      return;
    }
    if (monthlyDocScannerDraftIds.length >= 6) {
      alert("DocScanner資料は最大6件まで添付できます。");
      return;
    }
    const selectedBytes = monthlyDocScannerDocuments
      .filter((item) => monthlyDocScannerDraftIds.includes(item.id))
      .reduce((total, item) => total + item.fileSize, 0);
    if (selectedBytes + document.fileSize > 12_000_000) {
      alert("DocScanner資料の合計サイズは12MB以内にしてください。");
      return;
    }
    if (document.source === "doc-scanner") {
      const localSelectedBytes = monthlyDocScannerDocuments
        .filter((item) => item.source === "doc-scanner" && monthlyDocScannerDraftIds.includes(item.id))
        .reduce((total, item) => total + item.fileSize, 0);
      if (localSelectedBytes + document.fileSize > 3_500_000) {
        alert("DocScanner本体から直接取得する資料は合計3.5MB以内にしてください。");
        return;
      }
    }
    setMonthlyDocScannerDraftIds((ids) => [...ids, document.id]);
  }

  function removeMonthlyDocScannerDocument(documentId: string) {
    setMonthlySelectedDocScannerIds((ids) => ids.filter((id) => id !== documentId));
    setMonthlyDocScannerFiles((files) => {
      if (!(documentId in files)) return files;
      const nextFiles = { ...files };
      delete nextFiles[documentId];
      return nextFiles;
    });
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!manualUserId || !manualTime) return;

    setSaving(true);
    const res = await fetch("/api/admin/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: manualUserId,
        device_id: manualDeviceId || null,
        punch_type: manualPunchType,
        work_date: workDate,
        time: manualTime,
        memo: manualMemo,
        private_vehicle_place: manualPrivateVehiclePlace,
        private_vehicle_distance_km: manualPrivateVehicleDistanceKm,
        break_override_minutes: manualThirtyMinuteBreak ? 30 : null,
      }),
    });

    if (res.ok) {
      setManualMemo("");
      setManualPrivateVehiclePlace("");
      setManualPrivateVehicleDistanceKm("");
      setManualThirtyMinuteBreak(false);
      loadAttendance();
    } else {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "打刻修正に失敗しました");
    }
    setSaving(false);
  }

  function startEditPunch(punch: AttendancePunch) {
    setEditingPunchId(punch.id);
    setEditUserId(punch.user_id || "");
    setEditDeviceId(punch.device_id || "");
    setEditPunchType(punch.punch_type);
    setEditWorkDate(punch.work_date || workDate);
    setEditTime(punchTimeInput(punch.punched_at));
    setEditMemo(punch.memo || "");
    setEditPrivateVehiclePlace(punch.private_vehicle_place || "");
    setEditPrivateVehicleDistanceKm(
      punch.private_vehicle_distance_km === null || punch.private_vehicle_distance_km === undefined
        ? ""
        : String(punch.private_vehicle_distance_km),
    );
    setEditThirtyMinuteBreak(punch.break_override_minutes === 30);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPunchId || !editUserId || !editWorkDate || !editTime) return;

    setSaving(true);
    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        id: editingPunchId,
        user_id: editUserId,
        device_id: editDeviceId || null,
        punch_type: editPunchType,
        work_date: editWorkDate,
        time: editTime,
        memo: editMemo,
        private_vehicle_place: editPrivateVehiclePlace,
        private_vehicle_distance_km: editPrivateVehicleDistanceKm,
        break_override_minutes: editThirtyMinuteBreak ? 30 : null,
      }),
    });

    if (res.ok) {
      setEditingPunchId(null);
      if (editWorkDate !== workDate) setWorkDate(editWorkDate);
      if (editWorkDate < dateFrom || editWorkDate > dateTo) {
        setDateFrom(editWorkDate);
        setDateTo(editWorkDate);
        loadAttendance(editWorkDate, editWorkDate, includeVoidedPunches, attendanceUserFilter, attendanceDeviceFilter);
      } else {
        loadAttendance();
      }
    } else {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "打刻修正に失敗しました");
    }
    setSaving(false);
  }

  async function handleVoidPunch(punch: AttendancePunch) {
    if (punch.is_voided) return;
    const reason = prompt(`${punch.user?.display_name || "不明"} の ${punchTypeLabel(punch.punch_type)} を無効化する理由`, "誤打刻");
    if (reason === null) return;

    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: punch.id, reason }),
    });

    if (res.ok) loadAttendance();
    else {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "打刻の無効化に失敗しました");
    }
  }

  function togglePunchSelection(punchId: string) {
    setSelectedPunchIds((current) => (
      current.includes(punchId)
        ? current.filter((id) => id !== punchId)
        : [...current, punchId]
    ));
  }

  function selectVisiblePunches() {
    setSelectedPunchIds((data?.punches || [])
      .filter((punch) => !punch.is_voided)
      .map((punch) => punch.id));
  }

  async function handleBulkVoidPunches() {
    if (selectedPunchIds.length === 0 || saving) return;
    const reason = prompt(`${selectedPunchIds.length}件の打刻を一括削除（無効化）します。理由を入力してください。`, "テスト打刻削除");
    if (reason === null) return;
    if (!confirm(`${selectedPunchIds.length}件を給与計算対象から除外します。実行しますか？`)) return;

    setSaving(true);
    const res = await fetch("/api/admin/attendance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bulk_void",
        ids: selectedPunchIds,
        reason,
      }),
    });

    if (res.ok) {
      setSelectedPunchIds([]);
      loadAttendance();
    } else {
      const payload = await res.json().catch(() => ({}));
      alert(payload.error || "一括削除に失敗しました");
    }
    setSaving(false);
  }

  async function copyDeviceUrl(device: AttendanceDevice) {
    const url = terminalUrl(device);
    try {
      await navigator.clipboard.writeText(url);
      alert("端末URLをコピーしました");
    } catch {
      alert(url);
    }
  }

  const visiblePunches = data?.punches || [];
  const selectedPunchSet = new Set(selectedPunchIds);
  const groupedPunches = visiblePunches.reduce<Record<string, AttendancePunch[]>>((groups, punch) => {
    if (!groups[punch.work_date]) groups[punch.work_date] = [];
    groups[punch.work_date].push(punch);
    return groups;
  }, {});
  const activePunchCount = visiblePunches.filter((punch) => !punch.is_voided).length;
  const monthlyDepartmentUsers = (monthlyData?.users || []).filter((user) => user.department === monthlyDepartment);
  const selectedMonthlyUser = monthlyDepartmentUsers.find((user) => user.id === monthlyUserId) || null;
  const monthlyDates = datesInMonth(monthlyMonth);
  const monthlyChangedDates = changedMonthlyDates();
  const monthlyAllUsers = (monthlyData?.users || []).filter((user) => USER_DEPARTMENTS.includes(user.department));
  const monthlyValidUserIds = new Set(monthlyAllUsers.map((user) => user.id));
  const monthlyCheckedSet = new Set(monthlyCheckedUserIds.filter((id) => monthlyValidUserIds.has(id)));
  const monthlyTotalUsers = monthlyAllUsers.length;
  const monthlyCheckedCount = monthlyAllUsers.filter((user) => monthlyCheckedSet.has(user.id)).length;
  const monthlyAllChecked = monthlyTotalUsers > 0 && monthlyCheckedCount === monthlyTotalUsers;
  const monthlyDepartmentCheckSummary = USER_DEPARTMENTS.map((department) => {
    const users = monthlyAllUsers.filter((user) => user.department === department);
    const checked = users.filter((user) => monthlyCheckedSet.has(user.id)).length;
    return { department, total: users.length, checked };
  });
  const selectedMonthlyChecked = selectedMonthlyUser ? monthlyCheckedSet.has(selectedMonthlyUser.id) : false;
  const selectedMonthlyDocScannerDocuments = monthlyDocScannerDocuments.filter((document) => (
    monthlySelectedDocScannerIds.includes(document.id)
  ));
  const normalizedDocScannerSearch = monthlyDocScannerSearch.trim().toLocaleLowerCase("ja");
  const filteredMonthlyDocScannerDocuments = normalizedDocScannerSearch
    ? monthlyDocScannerDocuments.filter((document) => [
        document.employeeName,
        document.employeeCode,
        document.department,
        document.fileName,
        document.docType,
        document.docDate,
        document.counterpartyName,
        document.summary,
      ].some((value) => value?.toLocaleLowerCase("ja").includes(normalizedDocScannerSearch)))
    : monthlyDocScannerDocuments;

  return (
    <div className="admin-attendance">
      <section className="admin-panel">
        <div className="admin-panel__header">
          <div>
            <h3 className="admin-section-title">タイムレコーダー端末</h3>
            <p>本社・道の駅の専用端末で開くURLです。</p>
          </div>
          <button type="button" className="admin-btn-outline" onClick={() => loadAttendance()}>
            更新
          </button>
        </div>
        <div className="admin-device-grid">
          {(data?.devices || []).map((device) => (
            <div key={device.id} className="admin-device-card">
              <div className="admin-device-card__name">{device.name}</div>
              <div className="admin-device-card__sub">{device.location}</div>
              <a
                href={terminalUrl(device)}
                target="_blank"
                rel="noreferrer"
                className="admin-device-card__qr"
                aria-label={`${device.name} のタイムレコーダーQR`}
              >
                <img src={terminalQrUrl(device)} alt={`${device.name} のタイムレコーダーQRコード`} width={132} height={132} />
              </a>
              <div className="admin-device-card__url">{terminalUrl(device)}</div>
              <div className="admin-device-card__actions">
                <a href={terminalUrl(device)} target="_blank" rel="noreferrer" className="admin-btn-accent">
                  開く
                </a>
                <button type="button" className="admin-btn-outline" onClick={() => copyDeviceUrl(device)}>
                  コピー
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-panel admin-monthly-attendance">
        <div className="admin-panel__header">
          <div>
            <h3 className="admin-section-title">月末勤怠修正・労務士提出</h3>
            <p>所属ごとにスタッフの1か月分を確認し、全員チェック済みにしてから労務士へ送信します。</p>
          </div>
        </div>

        <div className="admin-monthly-flow" aria-label="労務士提出までの流れ">
          <div>
            <span>1</span>
            <strong>修正して保存</strong>
            <small>出勤・退勤・備考を確認</small>
          </div>
          <div>
            <span>2</span>
            <strong>スタッフごとにチェック完了</strong>
            <small>編集欄上部のボタンで確定</small>
          </div>
          <div>
            <span>3</span>
            <strong>労務士へ提出</strong>
            <small>3所属Excelを添付して送信</small>
          </div>
        </div>

        <div className="admin-monthly-toolbar">
          <label>
            <span>対象月</span>
            <input
              type="month"
              className="form-input"
              value={monthlyMonth}
              onChange={(event) => handleMonthlyMonthChange(event.target.value)}
            />
          </label>
          <button type="button" className="admin-btn-outline" onClick={() => loadMonthlyAttendance()} disabled={monthlyLoading}>
            更新
          </button>
          <div className="admin-monthly-save-state">
            {monthlyChangedDates.length > 0 ? `未保存 ${monthlyChangedDates.length}日` : "保存済み"}
          </div>
        </div>

        <div className={`admin-monthly-submit${monthlyAllChecked ? " admin-monthly-submit--ready" : ""}`}>
          <div className="admin-monthly-submit__main">
            <strong>提出チェック {monthlyCheckedCount}/{monthlyTotalUsers}</strong>
            <span>{monthlyAllChecked ? "全スタッフ確認済み" : "全員チェック済みで労務士提出できます"}</span>
          </div>
          <div className="admin-monthly-submit__departments">
            {monthlyDepartmentCheckSummary.map((item) => (
              <span key={item.department} className={item.total > 0 && item.checked === item.total ? "is-complete" : ""}>
                {item.department} {item.checked}/{item.total}
              </span>
            ))}
          </div>
          <div className="admin-monthly-docscanner">
            <div className="admin-monthly-docscanner__heading">
              <FolderArchive size={19} aria-hidden="true" />
              <div>
                <strong>DocScannerの書類を添付</strong>
                <small>書類一覧を開き、労務士へ送る資料だけを選択します。自動では追加されません。</small>
              </div>
              <button
                type="button"
                className="admin-monthly-docscanner__open"
                onClick={openMonthlyDocScannerPicker}
                disabled={monthlySubmitting}
              >
                <FolderArchive size={16} aria-hidden="true" />
                書類一覧から選択
              </button>
            </div>
            {monthlySelectedDocScannerIds.length === 0 ? (
              <p className="admin-monthly-docscanner__empty">DocScanner資料は選択されていません。</p>
            ) : (
              <div className="admin-monthly-docscanner__selected">
                {selectedMonthlyDocScannerDocuments.map((document) => (
                  <div key={document.id}>
                    <FileText size={16} aria-hidden="true" />
                    <span>
                      <strong title={document.fileName}>{document.fileName}</strong>
                      <small>
                        {document.employeeName || document.counterpartyName || document.docType || "書類"}
                        {` / ${formatFileSize(document.fileSize)}`}
                      </small>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMonthlyDocScannerDocument(document.id)}
                      disabled={monthlySubmitting}
                      aria-label={`${document.fileName}を選択から外す`}
                      title="選択から外す"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {monthlyDocScannerPickerOpen && (
            <div className="modal-overlay">
              <section
                className="modal-content admin-docscanner-picker"
                role="dialog"
                aria-modal="true"
                aria-labelledby="admin-docscanner-picker-title"
              >
                <div className="admin-docscanner-picker__header">
                  <div>
                    <h3 id="admin-docscanner-picker-title">DocScanner 書類一覧</h3>
                    <p>最新100件を一覧表示しています。氏名がない書類もファイル名から選べます。</p>
                  </div>
                  <button type="button" onClick={closeMonthlyDocScannerPicker} aria-label="書類一覧を閉じる" title="閉じる">
                    <X size={19} aria-hidden="true" />
                  </button>
                </div>
                <label className="admin-docscanner-picker__search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={monthlyDocScannerSearch}
                    onChange={(event) => setMonthlyDocScannerSearch(event.target.value)}
                    placeholder="一覧をファイル名・日付・取引先で絞り込み"
                    aria-label="DocScanner書類を検索"
                  />
                </label>
                {monthlyDocScannerLoading ? (
                  <p className="admin-monthly-docscanner__empty">書類一覧を読み込んでいます...</p>
                ) : monthlyDocScannerError ? (
                  <div className="admin-docscanner-picker__error">
                    <p>{monthlyDocScannerError}</p>
                    <button type="button" className="admin-btn-outline" onClick={() => loadMonthlyDocScannerDocuments()}>
                      再読み込み
                    </button>
                  </div>
                ) : filteredMonthlyDocScannerDocuments.length === 0 ? (
                  <p className="admin-monthly-docscanner__empty">
                    {monthlyDocScannerSearch ? "検索条件に一致する書類はありません。" : "選択できるDocScanner書類はありません。"}
                  </p>
                ) : (
                  <div className="admin-monthly-docscanner__list admin-docscanner-picker__list">
                    {filteredMonthlyDocScannerDocuments.map((document) => {
                      const selected = monthlyDocScannerDraftIds.includes(document.id);
                      return (
                        <label key={document.id} className={selected ? "is-selected" : ""}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleMonthlyDocScannerDocument(document)}
                            disabled={monthlySubmitting}
                          />
                          <span>
                            <strong title={document.fileName}>{document.fileName}</strong>
                            <small>
                              {document.employeeName || document.counterpartyName || document.docType || "書類"}
                              {document.docDate ? ` / ${document.docDate.replaceAll("-", "/")}` : ""}
                              {document.department ? ` / ${document.department}` : ""}
                              {document.employeeCode ? ` / 社員NO ${document.employeeCode}` : ""}
                              {document.hireDate ? ` / 入社日 ${document.hireDate.replaceAll("-", "/")}` : ""}
                            </small>
                            <small title={document.summary || ""}>
                              {document.summary || `取込 ${document.importedAt.slice(0, 10).replaceAll("-", "/")}`}
                              {` / ${formatFileSize(document.fileSize)}`}
                            </small>
                          </span>
                          {document.suggested && <em>対象月入社</em>}
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="admin-docscanner-picker__actions">
                  <span>{monthlyDocScannerDraftIds.length}件選択中（最大6件）</span>
                  <div>
                    <button type="button" className="admin-btn-outline" onClick={closeMonthlyDocScannerPicker}>
                      キャンセル
                    </button>
                    <button type="button" className="admin-btn-accent" onClick={confirmMonthlyDocScannerSelection} disabled={monthlyDocScannerLoading}>
                      選択を確定
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )}
          <div className="admin-monthly-attachments">
            <div className="admin-monthly-attachments__heading">
              <FileText size={18} aria-hidden="true" />
              <div>
                <strong>手元ファイルを追加（補助）</strong>
                <small>PDF・画像・Word・Excel・CSV・TXT・ZIP／最大6件・合計3.5MB</small>
              </div>
            </div>
            <label className="admin-monthly-attachments__pick">
              <Upload size={17} aria-hidden="true" />
              <span>ファイルを添付</span>
              <input
                ref={monthlyLaborAttachmentInputRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.xlsm,.csv,.txt,.zip"
                onChange={handleMonthlyLaborAttachmentChange}
                disabled={monthlyLoading || monthlySubmitting}
              />
            </label>
            {monthlyLaborAttachments.length > 0 && (
              <div className="admin-monthly-attachments__list">
                {monthlyLaborAttachments.map((file, index) => (
                  <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
                    <span title={file.name}>{file.name}</span>
                    <small>{formatFileSize(file.size)}</small>
                    <button
                      type="button"
                      onClick={() => removeMonthlyLaborAttachment(index)}
                      disabled={monthlySubmitting}
                      aria-label={`${file.name}を添付から外す`}
                      title="添付から外す"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="admin-monthly-submit__send">
            <button
              type="button"
              className="admin-btn-accent"
              onClick={handleSubmitMonthlyToLaborOffice}
              disabled={monthlyLoading || monthlySubmitting}
            >
              {monthlySubmitting ? "送信中..." : monthlyAllChecked ? "労務士へ提出" : "未チェックあり"}
            </button>
            <small>{monthlyAllChecked ? "押すと3所属分を送信します。" : "押すと未チェック人数を確認できます。"}</small>
          </div>
        </div>

        <details className="admin-monthly-downloads">
          <summary>送信できない時だけ予備Excelを開く</summary>
          <div>
            {USER_DEPARTMENTS.map((department) => (
              <button
                key={department}
                type="button"
                className="admin-btn-outline"
                onClick={() => downloadMonthlyExcel(department)}
                disabled={monthlyLoading}
              >
                {department}をダウンロード
              </button>
            ))}
          </div>
        </details>

        <div className="admin-monthly-departments" aria-label="所属選択">
          {USER_DEPARTMENTS.map((department) => (
            <button
              key={department}
              type="button"
              className={`admin-monthly-department${monthlyDepartment === department ? " admin-monthly-department--active" : ""}`}
              onClick={() => handleMonthlyDepartmentChange(department)}
              disabled={monthlyLoading}
            >
              <span>{departmentIcon(department)}</span>
              <strong>{department}</strong>
            </button>
          ))}
        </div>

        <div className="admin-monthly-layout">
          <aside className="admin-monthly-staff" aria-label={`${monthlyDepartment}のスタッフ`}>
            <div className="admin-monthly-staff__header">
              <strong>{monthlyDepartment}</strong>
              <span>{monthlyDepartmentUsers.length}名</span>
            </div>
            {monthlyLoading ? (
              <p className="admin-empty">読み込み中...</p>
            ) : monthlyDepartmentUsers.length === 0 ? (
              <p className="admin-empty">この所属のスタッフはいません</p>
            ) : (
              monthlyDepartmentUsers.map((user) => {
                const checked = monthlyCheckedSet.has(user.id);
                return (
                  <button
                    key={user.id}
                    type="button"
                    className={`admin-monthly-staff__button${monthlyUserId === user.id ? " admin-monthly-staff__button--active" : ""}${checked ? " admin-monthly-staff__button--checked" : ""}`}
                    onClick={() => setMonthlyUserId(user.id)}
                  >
                    <Avatar user={user} size={32} />
                    <span>{user.real_name || user.display_name}</span>
                    <small>{checked ? "チェック済" : "未チェック"}</small>
                  </button>
                );
              })
            )}
          </aside>

          <div className="admin-monthly-editor">
            <div className="admin-monthly-editor__header">
              <div>
                <span>修正対象</span>
                <strong>{selectedMonthlyUser ? selectedMonthlyUser.real_name || selectedMonthlyUser.display_name : "未選択"}</strong>
              </div>
              <div className="admin-monthly-editor__actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveMonthlyAll}
                  disabled={monthlySaving || monthlyChangedDates.length === 0 || !selectedMonthlyUser}
                >
                  {monthlySaving ? "保存中..." : "変更をまとめて保存"}
                </button>
              </div>
            </div>

            {selectedMonthlyUser ? (
              <div className={`admin-monthly-check-card${selectedMonthlyChecked ? " admin-monthly-check-card--done" : ""}`}>
                <div>
                  <strong>{selectedMonthlyUser.real_name || selectedMonthlyUser.display_name} の確認</strong>
                  <span>{selectedMonthlyChecked ? "このスタッフはチェック済みです。" : "修正を保存してから、このスタッフの確認完了を押してください。"}</span>
                </div>
                <button
                  type="button"
                  className={`admin-btn-outline${selectedMonthlyChecked ? " admin-monthly-check-btn--done" : ""}`}
                  onClick={() => toggleMonthlyStaffChecked(selectedMonthlyUser.id)}
                  disabled={monthlySaving}
                >
                  {selectedMonthlyChecked ? "チェック済みを解除" : "このスタッフをチェック完了"}
                </button>
              </div>
            ) : null}

            {!selectedMonthlyUser ? (
              <p className="admin-empty">左の一覧からスタッフを選択してください</p>
            ) : (
              <div className="admin-monthly-days">
                <div className="admin-monthly-days__header">
                  <span>日付</span>
                  <span>出勤</span>
                  <span>退勤</span>
                  <span>勤務</span>
                  <span>30休</span>
                  <span>労務士連絡</span>
                  <span>削除</span>
                </div>
                {monthlyDates.map((date) => {
                  const draft = monthlyDrafts[date] || {
                    work_date: date,
                    clock_in_time: "",
                    clock_out_time: "",
                    memo: "",
                    break_30: false,
                    private_vehicle_place: "",
                    private_vehicle_distance_km: "",
                    paid_leave: null,
                    bereavement_leave: false,
                  };
                  const changed = monthlyDraftSignature(draft) !== monthlyBaseline[date];
                  const workMinutes = calculateMonthlyDraftWorkMinutes(draft);

                  return (
                    <div
                      key={date}
                      className={`admin-monthly-day${changed ? " admin-monthly-day--changed" : ""}${draft.paid_leave || draft.bereavement_leave ? " admin-monthly-day--paid-leave" : ""}`}
                    >
                      <div className="admin-monthly-day__date">
                        <strong>{date.slice(5).replace("-", "/")}</strong>
                        <span>{weekdayLabel(date)}</span>
                        {draft.paid_leave && (
                          <em>
                            {draft.paid_leave.leaveUnit === "full_day" ? "有給" : "半休"}
                            <small>提出用打刻</small>
                          </em>
                        )}
                        {draft.bereavement_leave && (
                          <em>
                            忌引き休
                            <small>承認済み</small>
                          </em>
                        )}
                      </div>
                      <div className="admin-monthly-day__field">
                        <input
                          type="time"
                          className="form-input"
                          aria-label={`${date} 出勤`}
                          value={draft.clock_in_time}
                          onChange={(event) => updateMonthlyDraft(date, { clock_in_time: event.target.value })}
                          disabled={monthlySaving || Boolean(draft.paid_leave) || draft.bereavement_leave}
                        />
                      </div>
                      <div className="admin-monthly-day__field">
                        <input
                          type="time"
                          className="form-input"
                          aria-label={`${date} 退勤`}
                          value={draft.clock_out_time}
                          onChange={(event) => updateMonthlyDraft(date, { clock_out_time: event.target.value })}
                          disabled={monthlySaving || Boolean(draft.paid_leave) || draft.bereavement_leave}
                        />
                      </div>
                      <div className="admin-monthly-day__stat admin-monthly-day__stat--net">
                        <span>勤務</span>
                        <strong>{formatAttendanceMinutes(workMinutes)}</strong>
                      </div>
                      <div className="admin-monthly-day__break">
                        <button
                          type="button"
                          className={`admin-monthly-break${draft.break_30 ? " admin-monthly-break--active" : ""}`}
                          onClick={() => updateMonthlyDraft(date, { break_30: !draft.break_30 })}
                          disabled={monthlySaving || Boolean(draft.paid_leave) || draft.bereavement_leave}
                          aria-pressed={draft.break_30}
                          aria-label={`${date} 30分休憩`}
                          title={draft.break_30 ? "30分休憩を解除" : "30分休憩を指定"}
                        >
                          <span>30</span>
                          <small>休</small>
                        </button>
                      </div>
                      <div className="admin-monthly-day__memo">
                        <input
                          type="text"
                          className="form-input"
                          aria-label={`${date} 備考`}
                          value={draft.memo}
                          onChange={(event) => updateMonthlyDraft(date, { memo: event.target.value })}
                          placeholder="労務士へ伝えるメモ"
                          disabled={monthlySaving || Boolean(draft.paid_leave) || draft.bereavement_leave}
                        />
                      </div>
                      <button
                        type="button"
                        className="admin-monthly-day__delete"
                        onClick={() => handleDeleteMonthlyDay(date)}
                        disabled={monthlySaving || monthlyDeletingDate === date || Boolean(draft.paid_leave) || draft.bereavement_leave}
                        aria-label={`${date} の勤怠データを削除`}
                        title="この日の勤怠データを削除"
                      >
                        🗑
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel__header">
          <div>
            <h3 className="admin-section-title">打刻ログ</h3>
            <p>テスト打刻や誤打刻は削除扱いで無効化します。給与計算からは除外され、履歴は残ります。</p>
          </div>
        </div>

        <div className="admin-attendance-filter">
          <label>
            <span>開始日</span>
            <input
              type="date"
              className="form-input"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setWorkDate(event.target.value);
              }}
            />
          </label>
          <label>
            <span>終了日</span>
            <input
              type="date"
              className="form-input"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <label>
            <span>スタッフ</span>
            <select className="admin-select" value={attendanceUserFilter} onChange={(event) => setAttendanceUserFilter(event.target.value)}>
              <option value="">全員</option>
              {(data?.users || []).map((user) => (
                <option key={user.id} value={user.id}>{user.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>端末</span>
            <select className="admin-select" value={attendanceDeviceFilter} onChange={(event) => setAttendanceDeviceFilter(event.target.value)}>
              <option value="">全端末</option>
              {(data?.devices || []).map((device) => (
                <option key={device.id} value={device.id}>{device.name}</option>
              ))}
            </select>
          </label>
          <label className="admin-attendance-filter__check">
            <input
              type="checkbox"
              checked={includeVoidedPunches}
              onChange={(event) => setIncludeVoidedPunches(event.target.checked)}
            />
            <span>削除済みも表示</span>
          </label>
          <div className="admin-attendance-presets" aria-label="日付範囲のショートカット">
            <button type="button" className="admin-btn-outline" onClick={() => handleDatePreset("today")} disabled={loading}>
              今日
            </button>
            <button type="button" className="admin-btn-outline" onClick={() => handleDatePreset("currentMonth")} disabled={loading}>
              今月
            </button>
            <button type="button" className="admin-btn-outline" onClick={() => handleDatePreset("previousMonth")} disabled={loading}>
              先月
            </button>
          </div>
          <button type="button" className="btn-primary" onClick={() => loadAttendance()} disabled={loading}>
            表示
          </button>
        </div>

        <div className="admin-attendance-bulk">
          <div>
            <strong>{visiblePunches.length}件</strong>
            <span>表示中 / 有効 {activePunchCount}件 / 選択 {selectedPunchIds.length}件</span>
          </div>
          <div className="admin-attendance-bulk__actions">
            <button type="button" className="admin-btn-outline" onClick={selectVisiblePunches} disabled={loading || activePunchCount === 0}>
              表示中を全選択
            </button>
            <button type="button" className="admin-btn-outline" onClick={() => setSelectedPunchIds([])} disabled={selectedPunchIds.length === 0}>
              選択解除
            </button>
            <button type="button" className="admin-btn-danger" onClick={handleBulkVoidPunches} disabled={saving || selectedPunchIds.length === 0}>
              選択を一括削除
            </button>
          </div>
        </div>

        <details className="admin-attendance-manual">
          <summary>打刻を手動追加</summary>
        <form className="admin-attendance-form" onSubmit={handleManualSubmit}>
          <select className="admin-select" value={manualUserId} onChange={(event) => setManualUserId(event.target.value)}>
            {(data?.users || []).map((user) => (
              <option key={user.id} value={user.id}>{user.display_name}</option>
            ))}
          </select>
          <select className="admin-select" value={manualPunchType} onChange={(event) => setManualPunchType(event.target.value as "clock_in" | "clock_out")}>
            <option value="clock_in">出勤</option>
            <option value="clock_out">退勤</option>
          </select>
          <input
            type="time"
            className="form-input"
            value={manualTime}
            onChange={(event) => setManualTime(event.target.value)}
          />
          <select className="admin-select" value={manualDeviceId} onChange={(event) => setManualDeviceId(event.target.value)}>
            <option value="">端末なし</option>
            {(data?.devices || []).map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
          <input
            type="text"
            className="form-input"
            value={manualMemo}
            onChange={(event) => setManualMemo(event.target.value)}
            placeholder="メモ"
          />
          <input
            type="text"
            className="form-input"
            value={manualPrivateVehiclePlace}
            onChange={(event) => setManualPrivateVehiclePlace(event.target.value)}
            placeholder="自家用車 場所"
          />
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.1"
            className="form-input"
            value={manualPrivateVehicleDistanceKm}
            onChange={(event) => setManualPrivateVehicleDistanceKm(event.target.value)}
            placeholder="自家用車 km"
          />
          <button
            type="button"
            className={`admin-toggle-btn${manualThirtyMinuteBreak ? " admin-toggle-btn--active" : ""}`}
            onClick={() => setManualThirtyMinuteBreak((current) => !current)}
          >
            30分休憩
          </button>
          <button type="submit" className="btn-primary" disabled={saving || loading}>
            追加
          </button>
        </form>
        </details>

        {loading ? (
          <p className="admin-empty">読み込み中...</p>
        ) : !data?.punches.length ? (
          <p className="admin-empty">この日の打刻はありません</p>
        ) : (
          <div className="admin-punch-list admin-punch-list--scroll">
            {Object.entries(groupedPunches).map(([date, punches]) => (
              <section key={date} className="admin-punch-day">
                <div className="admin-punch-day__header">
                  <strong>{date}</strong>
                  <span>{punches.length}件</span>
                </div>
                {punches.map((punch) => (
                  <div key={punch.id} className={`admin-punch-item${punch.is_voided ? " admin-punch-item--voided" : ""}`}>
                    <label className="admin-punch-check" aria-label={`${punch.user?.display_name || "不明"} を選択`}>
                      <input
                        type="checkbox"
                        checked={selectedPunchSet.has(punch.id)}
                        onChange={() => togglePunchSelection(punch.id)}
                        disabled={punch.is_voided || saving}
                      />
                    </label>
                    <Avatar
                      user={{ display_name: punch.user?.display_name || "不明", picture_url: punch.user?.picture_url || null }}
                      size={34}
                    />
                    <div className="admin-punch-item__main">
                      <strong>{punch.user?.display_name || "不明"}</strong>
                      <span>
                        {formatPunchTime(punch.punched_at)} / {punchTypeLabel(punch.punch_type)}
                        {punch.device ? ` / ${punch.device.name}` : ""}
                        {punch.source_type === "admin" ? " / 管理修正" : ""}
                      </span>
                      {(punch.private_vehicle_place || (punch.private_vehicle_distance_km !== null && punch.private_vehicle_distance_km !== undefined)) && (
                        <em>
                          自家用車:
                          {punch.private_vehicle_place ? ` ${punch.private_vehicle_place}` : ""}
                          {punch.private_vehicle_distance_km !== null && punch.private_vehicle_distance_km !== undefined ? ` ${punch.private_vehicle_distance_km}km` : ""}
                        </em>
                      )}
                      {punch.break_override_minutes === 30 && <em>30分休憩指定</em>}
                      {punch.memo && <em>備考: {punch.memo}</em>}
                      {punch.is_voided && <em>削除済み: {punch.void_reason || "理由なし"}</em>}
                    </div>
                    <div className="admin-punch-item__actions">
                      <button
                        type="button"
                        className="admin-btn-outline"
                        onClick={() => startEditPunch(punch)}
                        disabled={punch.is_voided}
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        className="admin-btn-outline"
                        onClick={() => handleVoidPunch(punch)}
                        disabled={punch.is_voided}
                      >
                        削除
                      </button>
                    </div>
                    {editingPunchId === punch.id && (
                      <form className="admin-attendance-edit" onSubmit={handleEditSubmit}>
                    <select className="admin-select" value={editUserId} onChange={(event) => setEditUserId(event.target.value)}>
                      {(data?.users || []).map((user) => (
                        <option key={user.id} value={user.id}>{user.display_name}</option>
                      ))}
                    </select>
                    <select className="admin-select" value={editPunchType} onChange={(event) => setEditPunchType(event.target.value as "clock_in" | "clock_out")}>
                      <option value="clock_in">出勤</option>
                      <option value="clock_out">退勤</option>
                    </select>
                    <input
                      type="date"
                      className="form-input"
                      value={editWorkDate}
                      onChange={(event) => setEditWorkDate(event.target.value)}
                    />
                    <input
                      type="time"
                      className="form-input"
                      value={editTime}
                      onChange={(event) => setEditTime(event.target.value)}
                    />
                    <select className="admin-select" value={editDeviceId} onChange={(event) => setEditDeviceId(event.target.value)}>
                      <option value="">端末なし</option>
                      {(data?.devices || []).map((device) => (
                        <option key={device.id} value={device.id}>{device.name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="form-input"
                      value={editPrivateVehiclePlace}
                      onChange={(event) => setEditPrivateVehiclePlace(event.target.value)}
                      placeholder="自家用車 場所"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      className="form-input"
                      value={editPrivateVehicleDistanceKm}
                      onChange={(event) => setEditPrivateVehicleDistanceKm(event.target.value)}
                      placeholder="自家用車 km"
                    />
                    <input
                      type="text"
                      className="form-input admin-attendance-edit__memo"
                      value={editMemo}
                      onChange={(event) => setEditMemo(event.target.value)}
                      placeholder="備考"
                    />
                    <button
                      type="button"
                      className={`admin-toggle-btn${editThirtyMinuteBreak ? " admin-toggle-btn--active" : ""}`}
                      onClick={() => setEditThirtyMinuteBreak((current) => !current)}
                    >
                      30分休憩
                    </button>
                    <div className="admin-attendance-edit__actions">
                      <button type="button" className="admin-btn-outline" onClick={() => setEditingPunchId(null)} disabled={saving}>
                        キャンセル
                      </button>
                      <button type="submit" className="btn-primary" disabled={saving}>
                        保存
                      </button>
                    </div>
                      </form>
                    )}
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── 給与・労務タブ ───
function PayrollLaborAdminTab() {
  const [view, setView] = useState<"verification" | "results">("verification");

  return (
    <div className="admin-payroll-hub">
      <div className="admin-payroll-hub__switch" role="tablist" aria-label="給与・労務の表示切替">
        <button
          type="button"
          role="tab"
          aria-selected={view === "verification"}
          className={view === "verification" ? "admin-payroll-hub__tab admin-payroll-hub__tab--active" : "admin-payroll-hub__tab"}
          onClick={() => setView("verification")}
        >
          <FolderArchive size={18} aria-hidden="true" />
          <span><b>取込・照合</b><small>労務士ZIPと自社計算を検証</small></span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "results"}
          className={view === "results" ? "admin-payroll-hub__tab admin-payroll-hub__tab--active" : "admin-payroll-hub__tab"}
          onClick={() => setView("results")}
        >
          <Banknote size={18} aria-hidden="true" />
          <span><b>確定給与・人件費</b><small>月別・組織別・社員別に確認</small></span>
        </button>
      </div>
      {view === "verification" ? <LaborDataAdminTab /> : <PayrollAdminTab />}
    </div>
  );
}

// ─── 給与計算表示 ───
function PayrollAdminTab() {
  const [costPayload, setCostPayload] = useState<LaborCostsPayload | null>(null);
  const [calculationPayload, setCalculationPayload] = useState<PayrollCalculationProfilesPayload | null>(null);
  const [costLoading, setCostLoading] = useState(true);
  const [calculationLoading, setCalculationLoading] = useState(true);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState("all");

  function loadLaborCosts() {
    setCostLoading(true);
    fetch("/api/admin/payroll/labor-costs", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((nextPayload: LaborCostsPayload) => {
        setCostPayload(nextPayload);
        if (selectedPeriodKey !== "all" && !nextPayload.monthlySummary.some((period) => period.periodKey === selectedPeriodKey)) {
          setSelectedPeriodKey(nextPayload.summary.latestPeriodKey || "all");
        }
      })
      .catch(() => setCostPayload(null))
      .finally(() => setCostLoading(false));
  }

  function loadCalculationProfiles() {
    setCalculationLoading(true);
    fetch("/api/admin/payroll/calculation-profiles", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((nextPayload: PayrollCalculationProfilesPayload) => setCalculationPayload(nextPayload))
      .catch(() => setCalculationPayload(null))
      .finally(() => setCalculationLoading(false));
  }

  function reloadPayroll() {
    loadLaborCosts();
    loadCalculationProfiles();
  }

  useEffect(() => {
    reloadPayroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const costDetails = costPayload?.details || [];
  const scopedCostDetails = selectedPeriodKey === "all"
    ? costDetails
    : costDetails.filter((row) => row.periodKey === selectedPeriodKey);
  const scopedPaymentTotal = scopedCostDetails.reduce((sum, row) => sum + row.paymentTotal, 0);
  const scopedNetPayment = scopedCostDetails.reduce((sum, row) => sum + row.netPayment, 0);
  const scopedOrganizationSummary = Array.from(
    scopedCostDetails.reduce((map, row) => {
      const current = map.get(row.organization) || { organization: row.organization, resultCount: 0, paymentTotal: 0, netPayment: 0 };
      current.resultCount += 1;
      current.paymentTotal += row.paymentTotal;
      current.netPayment += row.netPayment;
      map.set(row.organization, current);
      return map;
    }, new Map<string, LaborCostOrganizationSummary>()).values(),
  ).sort((a, b) => b.paymentTotal - a.paymentTotal);
  const scopedEmployeeSummary = Array.from(
    scopedCostDetails.reduce((map, row) => {
      const current = map.get(row.employeeName) || {
        employeeId: row.employeeName,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        organization: row.organization,
        months: 0,
        paymentTotal: 0,
        netPayment: 0,
      };
      current.months += 1;
      current.paymentTotal += row.paymentTotal;
      current.netPayment += row.netPayment;
      map.set(row.employeeName, current);
      return map;
    }, new Map<string, LaborCostEmployeeSummary>()).values(),
  ).sort((a, b) => b.paymentTotal - a.paymentTotal);
  const selectedPeriod = costPayload?.monthlySummary.find((period) => period.periodKey === selectedPeriodKey);
  const selectedPeriodLabel = selectedPeriodKey === "all"
    ? "全期間"
    : selectedPeriod
      ? formatPayrollMonth(selectedPeriod.payrollMonth, selectedPeriod.payrollKindLabel)
      : "選択期間";

  return (
    <div className="admin-payroll">
      <section className="admin-payroll-heading">
        <div>
          <span className="admin-payroll-kicker">Payroll Calculation</span>
          <h3 className="admin-section-title">給与計算</h3>
          <p>支払い済み給与・賞与の集計と、今後の給与計算ロジックを扱う画面です。人事情報の削除とは分離します。</p>
        </div>
        <div className="admin-payroll-heading__actions">
          <button type="button" className="admin-btn-outline" onClick={reloadPayroll} disabled={costLoading || calculationLoading}>
            金額更新
          </button>
        </div>
      </section>

      {costPayload && (
        <div className="admin-payroll-summary admin-payroll-summary--cost">
          <div><strong>{formatCurrency(scopedPaymentTotal || costPayload.summary.paymentTotal)}</strong><span>支給合計</span></div>
          <div><strong>{formatCurrency(scopedNetPayment || costPayload.summary.netPayment)}</strong><span>差引支給額</span></div>
          <div><strong>{selectedPeriodKey === "all" ? costPayload.summary.periods : 1}</strong><span>対象月</span></div>
          <div><strong>{scopedCostDetails.length || costPayload.summary.resultCount}</strong><span>明細数</span></div>
        </div>
      )}

      <div className="admin-payroll-workbench admin-payroll-workbench--payroll">
        <aside className="admin-payroll-side">
          <section className="admin-payroll-card admin-payroll-card--controls">
            <div className="admin-payroll-card__header">
              <div>
                <h4>対象期間</h4>
                <p>{selectedPeriodLabel} の人件費を表示中</p>
              </div>
            </div>
            <select
              className="admin-select admin-payroll-period-select"
              value={selectedPeriodKey}
              onChange={(event) => setSelectedPeriodKey(event.target.value)}
              disabled={!costPayload || costLoading}
            >
              <option value="all">全期間</option>
              {(costPayload?.monthlySummary || []).map((period) => (
                <option key={period.periodKey} value={period.periodKey}>
                  {formatPayrollMonth(period.payrollMonth, period.payrollKindLabel)}
                </option>
              ))}
            </select>
          </section>

          <section className="admin-payroll-card">
            <div className="admin-payroll-card__header">
              <div>
                <h4>組織別</h4>
                <p>選択期間の支給額順</p>
              </div>
            </div>
            {costLoading ? (
              <p className="admin-empty">読み込み中...</p>
            ) : !costPayload ? (
              <p className="admin-empty">人件費データを読み込めませんでした</p>
            ) : (
              <div className="admin-payroll-table-wrap admin-payroll-table-wrap--compact">
                <table className="admin-payroll-table admin-payroll-table--compact">
                  <thead>
                    <tr>
                      <th>組織</th>
                      <th>明細</th>
                      <th>支給</th>
                      <th>差引</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scopedOrganizationSummary.map((row) => (
                      <tr key={row.organization}>
                        <td>{row.organization}</td>
                        <td>{row.resultCount}</td>
                        <td>{formatCurrency(row.paymentTotal)}</td>
                        <td>{formatCurrency(row.netPayment)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </aside>

        <div className="admin-payroll-main">
          {costLoading ? (
            <section className="admin-payroll-card">
              <p className="admin-empty">人件費データを読み込み中...</p>
            </section>
          ) : !costPayload ? (
            <section className="admin-payroll-card">
              <p className="admin-empty">人件費データを読み込めませんでした</p>
            </section>
          ) : (
            <>
              <section className="admin-payroll-card">
                <div className="admin-payroll-card__header">
                  <div>
                    <h4>給与計算ロジック</h4>
                    <p>労務士データから推定した社員別の計算型と、打刻ベースの今月試算です。</p>
                  </div>
                </div>
                {calculationLoading ? (
                  <p className="admin-empty">給与計算ロジックを読み込み中...</p>
                ) : !calculationPayload ? (
                  <p className="admin-empty">給与計算ロジックを読み込めませんでした</p>
                ) : (
                  <>
                    <div className="admin-payroll-summary admin-payroll-summary--cost">
                      <div><strong>{calculationPayload.summary.profiles}</strong><span>設定済み</span></div>
                      <div><strong>{calculationPayload.summary.calculatedEmployees}</strong><span>今月打刻あり</span></div>
                      <div><strong>{formatCurrency(calculationPayload.summary.paymentTotal)}</strong><span>今月支給試算</span></div>
                      <div><strong>{formatCurrency(calculationPayload.summary.netPayment)}</strong><span>差引試算</span></div>
                    </div>
                    <div className="admin-payroll-table-wrap">
                      <table className="admin-payroll-table">
                        <thead>
                          <tr>
                            <th>社員</th>
                            <th>型</th>
                            <th>基本給/時給</th>
                            <th>除数</th>
                            <th>所定</th>
                            <th>検算差</th>
                            <th>今月勤務</th>
                            <th>今月残業</th>
                            <th>支給試算</th>
                            <th>差引試算</th>
                          </tr>
                        </thead>
                        <tbody>
                          {calculationPayload.profiles.map((row) => (
                            <tr key={row.profileId}>
                              <td>
                                {row.employeeCode ? `${row.employeeCode} ${row.employeeName}` : row.employeeName}
                                {row.consistencyWarnings?.map((warning) => (
                                  <small className="admin-payroll-consistency-warning" key={warning}>{warning}</small>
                                ))}
                              </td>
                              <td>{calculationTypeLabel(row.calculationType)}</td>
                              <td>{row.calculationType === "hourly" ? `${formatCurrency(row.hourlyRate)}/h` : formatCurrency(row.monthlyBaseAmount)}</td>
                              <td>{row.overtimeDivisor || "-"}</td>
                              <td>{row.scheduledMinutes ? formatPayrollMinutes(row.scheduledMinutes) : "-"}</td>
                              <td>{typeof row.verification?.delta === "number" ? formatCurrency(row.verification.delta) : "-"}</td>
                              <td>{`${row.calculation.attendance.workDays}日 ${formatPayrollMinutes(row.calculation.attendance.workMinutes)}`}</td>
                              <td>{formatPayrollMinutes(row.calculation.attendance.weekdaySaturdayOvertimeMinutes + row.calculation.attendance.sundayOvertimeMinutes)}</td>
                              <td>{formatCurrency(row.calculation.paymentTotal)}</td>
                              <td>{formatCurrency(row.calculation.netPayment)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>

              <section className="admin-payroll-card">
                <div className="admin-payroll-card__header">
                  <div>
                    <h4>月別推移</h4>
                    <p>支給日・人数・支給/控除/差引を月単位で確認します。</p>
                  </div>
                </div>
                <div className="admin-payroll-table-wrap">
                  <table className="admin-payroll-table">
                    <thead>
                      <tr>
                        <th>月</th>
                        <th>支給日</th>
                        <th>人数</th>
                        <th>支給合計</th>
                        <th>控除合計</th>
                        <th>差引支給額</th>
                        <th>配賦額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costPayload.monthlySummary.map((period) => (
                        <tr key={period.periodKey}>
                          <td>{formatPayrollMonth(period.payrollMonth, period.payrollKindLabel)}</td>
                          <td>{formatOptionalDate(period.payDate)}</td>
                          <td>{period.resultCount}</td>
                          <td>{formatCurrency(period.paymentTotal)}</td>
                          <td>{formatCurrency(period.deductionTotal)}</td>
                          <td>{formatCurrency(period.netPayment)}</td>
                          <td>{formatCurrency(period.allocationTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="admin-payroll-card">
                <div className="admin-payroll-card__header">
                  <div>
                    <h4>人別ランキング</h4>
                    <p>{selectedPeriodLabel} の支給合計上位を表示します。</p>
                  </div>
                </div>
                <div className="admin-payroll-table-wrap">
                  <table className="admin-payroll-table">
                    <thead>
                      <tr>
                        <th>氏名</th>
                        <th>所属</th>
                        <th>回数</th>
                        <th>支給合計</th>
                        <th>差引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scopedEmployeeSummary.slice(0, 80).map((row) => (
                        <tr key={`${row.employeeName}-${row.employeeCode || "no-code"}`}>
                          <td>{row.employeeCode ? `${row.employeeCode} ${row.employeeName}` : row.employeeName}</td>
                          <td>{row.organization}</td>
                          <td>{row.months}</td>
                          <td>{formatCurrency(row.paymentTotal)}</td>
                          <td>{formatCurrency(row.netPayment)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="admin-payroll-card">
                <div className="admin-payroll-card__header">
                  <div>
                    <h4>給与明細</h4>
                    <p>対象期間の明細を最大120件表示します。</p>
                  </div>
                </div>
                <div className="admin-payroll-table-wrap">
                  <table className="admin-payroll-table">
                    <thead>
                      <tr>
                        <th>月</th>
                        <th>氏名</th>
                        <th>所属</th>
                        <th>支給合計</th>
                        <th>控除</th>
                        <th>差引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scopedCostDetails.slice(0, 120).map((row) => (
                        <tr key={row.id}>
                          <td>{formatPayrollMonth(row.payrollMonth, row.payrollKindLabel)}</td>
                          <td>{row.employeeCode ? `${row.employeeCode} ${row.employeeName}` : row.employeeName}</td>
                          <td>{row.organization}</td>
                          <td>{formatCurrency(row.paymentTotal)}</td>
                          <td>{formatCurrency(row.deductionTotal)}</td>
                          <td>{formatCurrency(row.netPayment)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 人事管理タブ ───
function HRAdminTab({ currentUser }: { currentUser: User | null }) {
  const [payload, setPayload] = useState<HREmployeesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [savingEmployeeId, setSavingEmployeeId] = useState<string | null>(null);
  const [resumeBusyEmployeeId, setResumeBusyEmployeeId] = useState<string | null>(null);
  const [resumeMessages, setResumeMessages] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, HRProfile>>({});
  const [coreDrafts, setCoreDrafts] = useState<Record<string, HRCoreDraft>>({});
  const [expandedEmployeeIds, setExpandedEmployeeIds] = useState<Set<string>>(() => new Set());
  const employeeRequestActiveRef = useRef(false);
  const lastEmployeeRefreshAtRef = useRef(0);

  const loadEmployees = useCallback(async (background = false) => {
    if (employeeRequestActiveRef.current) return;
    employeeRequestActiveRef.current = true;
    lastEmployeeRefreshAtRef.current = Date.now();
    if (!background) setLoading(true);
    try {
      const response = await fetch("/api/admin/hr/employees", { cache: "no-store" });
      if (!response.ok) throw new Error("人事情報を取得できませんでした");
      setPayload(await response.json() as HREmployeesPayload);
    } catch {
      if (!background) setPayload(null);
    } finally {
      employeeRequestActiveRef.current = false;
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEmployees();

    const refreshAfterReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastEmployeeRefreshAtRef.current < 1000) return;
      void loadEmployees(true);
    };

    window.addEventListener("focus", refreshAfterReturn);
    window.addEventListener("pageshow", refreshAfterReturn);
    document.addEventListener("visibilitychange", refreshAfterReturn);
    return () => {
      window.removeEventListener("focus", refreshAfterReturn);
      window.removeEventListener("pageshow", refreshAfterReturn);
      document.removeEventListener("visibilitychange", refreshAfterReturn);
    };
  }, [loadEmployees]);

  async function updateHREmployee(employee: HREmployee, changes: { action?: "retire"; user_id?: string | null; employee_code?: string | null; hire_date?: string | null; kana?: string | null; birth_date?: string | null; gender?: string | null; payroll_status?: string; resigned_date?: string | null; work_style?: WorkStyle | null; basic_work_start?: string | null; basic_work_end?: string | null; basic_break_minutes?: number | string | null; hr_profile?: HRProfile }) {
    setSavingEmployeeId(employee.id);
    const res = await fetch("/api/admin/hr/employees", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: employee.id, ...changes }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "人事情報の更新に失敗しました");
      setSavingEmployeeId(null);
      return;
    }

    await loadEmployees();
    setSavingEmployeeId(null);
  }

  async function retireEmployee(employee: HREmployee) {
    const defaultDate = employee.resigned_date || new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const resignedDate = window.prompt(
      `${employee.real_name || employee.display_name} の退職日を入力してください（YYYY-MM-DD）。\nログインを停止しますが、給与・勤怠・投稿履歴は残ります。`,
      defaultDate,
    );
    if (resignedDate === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(resignedDate)) {
      alert("退職日は YYYY-MM-DD 形式で入力してください");
      return;
    }
    if (!window.confirm(`${employee.real_name || employee.display_name} を ${resignedDate} 退職として処理しますか？`)) return;
    await updateHREmployee(employee, { action: "retire", resigned_date: resignedDate });
  }

  function clearEmployeeDrafts(employeeId: string) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[employeeId];
      return next;
    });
    setCoreDrafts((current) => {
      const next = { ...current };
      delete next[employeeId];
      return next;
    });
  }

  async function uploadResume(employee: HREmployee, file: File) {
    setResumeBusyEmployeeId(employee.id);
    setResumeMessages((current) => ({ ...current, [employee.id]: "履歴書を保存し、AIで読み取っています..." }));
    try {
      const form = new FormData();
      form.append("employee_id", employee.id);
      form.append("file", file);
      const response = await fetch("/api/admin/hr/resumes", { method: "POST", body: form });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        ocr?: { status?: string; error?: string; extractedData?: { appliedFields?: string[]; warnings?: string[] } };
      };
      if (!response.ok) throw new Error(body.error || "履歴書を保存できませんでした");

      const appliedCount = body.ocr?.extractedData?.appliedFields?.length || 0;
      const warning = body.ocr?.extractedData?.warnings?.[0];
      const message = body.ocr?.status === "completed"
        ? `PDFを保存し、AI読取で人事情報${appliedCount}項目を補完しました${warning ? `。${warning}` : ""}`
        : `PDFは保存しましたが、AI読取に失敗しました。${body.ocr?.error || "再実行してください"}`;
      setResumeMessages((current) => ({ ...current, [employee.id]: message }));
      clearEmployeeDrafts(employee.id);
      await loadEmployees();
    } catch (error) {
      setResumeMessages((current) => ({
        ...current,
        [employee.id]: error instanceof Error ? error.message : "履歴書を保存できませんでした",
      }));
    } finally {
      setResumeBusyEmployeeId(null);
    }
  }

  async function retryResumeOcr(employee: HREmployee) {
    if (!employee.resume_document) return;
    setResumeBusyEmployeeId(employee.id);
    setResumeMessages((current) => ({ ...current, [employee.id]: "保存済みPDFをAIで再読取しています..." }));
    try {
      const response = await fetch("/api/admin/hr/resumes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: employee.resume_document.id }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        ocr?: { status?: string; error?: string; extractedData?: { appliedFields?: string[]; warnings?: string[] } };
      };
      if (!response.ok) throw new Error(body.error || "AI読取を再実行できませんでした");
      const appliedCount = body.ocr?.extractedData?.appliedFields?.length || 0;
      const warning = body.ocr?.extractedData?.warnings?.[0];
      const message = body.ocr?.status === "completed"
        ? `AI読取を完了し、人事情報${appliedCount}項目を補完しました${warning ? `。${warning}` : ""}`
        : `AI読取に失敗しました。${body.ocr?.error || "時間を置いて再実行してください"}`;
      setResumeMessages((current) => ({ ...current, [employee.id]: message }));
      clearEmployeeDrafts(employee.id);
      await loadEmployees();
    } catch (error) {
      setResumeMessages((current) => ({
        ...current,
        [employee.id]: error instanceof Error ? error.message : "AI読取を再実行できませんでした",
      }));
    } finally {
      setResumeBusyEmployeeId(null);
    }
  }

  async function deleteResume(employee: HREmployee) {
    if (!employee.resume_document) return;
    if (!window.confirm(`${employee.real_name || employee.display_name} の履歴書PDFを削除しますか？`)) return;
    setResumeBusyEmployeeId(employee.id);
    try {
      const response = await fetch("/api/admin/hr/resumes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: employee.resume_document.id }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "履歴書を削除できませんでした");
      setResumeMessages((current) => ({ ...current, [employee.id]: "履歴書PDFを削除しました" }));
      await loadEmployees();
    } catch (error) {
      setResumeMessages((current) => ({
        ...current,
        [employee.id]: error instanceof Error ? error.message : "履歴書を削除できませんでした",
      }));
    } finally {
      setResumeBusyEmployeeId(null);
    }
  }

  async function deleteRetiredEmployee(employee: HREmployee) {
    if (employee.payroll_status !== "retired") {
      alert("退職者のみ削除できます。先に退職へ変更してください。");
      return;
    }

    const reason = window.prompt(
      `${employee.real_name || employee.display_name} の人事個人情報とTSG連携を削除します。給与・勤怠履歴は残ります。理由を入力してください。`,
      "退職者の個人情報削除",
    );
    if (reason === null) return;

    setSavingEmployeeId(employee.id);
    const res = await fetch("/api/admin/hr/employees", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: employee.id, reason }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "退職者削除に失敗しました");
      setSavingEmployeeId(null);
      return;
    }

    await loadEmployees();
    setSavingEmployeeId(null);
  }

  const employees = payload?.employees || [];
  const hrUsers = payload?.users || [];
  const linkedUserIds = new Set(employees.map((employee) => employee.user_id).filter(Boolean));
  const filteredEmployees = employees
    .filter((employee) => {
      if (!includeDeleted && employee.is_hr_deleted) return false;
      const keyword = filter.trim();
      if (!keyword) return true;
      const profile = employee.hr_profile || {};
      const department = employeeTSGDepartment(employee);
      return [
        employee.employee_code,
        employee.display_name,
        employee.real_name,
        employee.kana,
        department,
        employee.department,
        employee.workplace?.name,
        employee.user?.display_name,
        profile.phone,
        profile.email,
        profile.address,
      ].some((value) => (value || "").includes(keyword));
    })
    .sort((a, b) => compareHREmployees(a, b, currentUser));

  function draftValue(employee: HREmployee, key: keyof HRProfile) {
    const value = drafts[employee.id]?.[key] ?? employee.hr_profile?.[key] ?? "";
    return typeof value === "string" ? value : "";
  }

  function coreDraftValue(employee: HREmployee, key: keyof HRCoreDraft) {
    const value = coreDrafts[employee.id]?.[key] ?? employee[key] ?? "";
    return String(value);
  }

  function updateCoreDraft(employee: HREmployee, key: keyof HRCoreDraft, value: string) {
    setCoreDrafts((current) => ({
      ...current,
      [employee.id]: {
        hire_date: employee.hire_date || "",
        kana: employee.kana || "",
        birth_date: employee.birth_date || "",
        gender: employee.gender || "",
        basic_work_start: employee.basic_work_start || "",
        basic_work_end: employee.basic_work_end || "",
        basic_break_minutes: employee.basic_break_minutes === null || employee.basic_break_minutes === undefined ? "" : String(employee.basic_break_minutes),
        ...(current[employee.id] || {}),
        [key]: value,
      },
    }));
  }

  function updateDraft(employee: HREmployee, key: keyof HRProfile, value: string) {
    setDrafts((current) => ({
      ...current,
      [employee.id]: {
        ...(employee.hr_profile || {}),
        ...(current[employee.id] || {}),
        [key]: value,
      },
    }));
  }

  function toggleEmployeeDetails(employeeId: string) {
    setExpandedEmployeeIds((current) => {
      const next = new Set(current);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }

  return (
    <div className="admin-hr">
      <section className="admin-payroll-heading">
        <div>
          <span className="admin-payroll-kicker">Human Resources</span>
          <h3 className="admin-section-title">人事管理</h3>
          <p>スタッフの所属、連絡先、TSG連携、退職処理を扱います。削除しても給与計算済みデータは残します。</p>
        </div>
        <button type="button" className="admin-btn-outline" onClick={() => void loadEmployees()} disabled={loading}>
          更新
        </button>
      </section>

      <div className="admin-payroll-summary admin-payroll-summary--cost">
        <div><strong>{payload?.summary.total ?? "-"}</strong><span>人員マスタ</span></div>
        <div><strong>{payload?.summary.active ?? "-"}</strong><span>在籍</span></div>
        <div><strong>{payload?.summary.retired ?? "-"}</strong><span>退職</span></div>
        <div><strong>{payload?.summary.deleted ?? "-"}</strong><span>削除済み</span></div>
      </div>

      <section className="admin-payroll-card">
        <div className="admin-hr-toolbar">
          <input
            type="search"
            className="form-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="名前・社員コード・電話・住所で検索"
          />
          <label className="form-check admin-hr-check">
            <input type="checkbox" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} />
            <span>削除済みも表示</span>
          </label>
        </div>

        {loading ? (
          <p className="admin-empty">読み込み中...</p>
        ) : !filteredEmployees.length ? (
          <p className="admin-empty">該当するスタッフがいません</p>
        ) : (
          <div className="admin-hr-list">
            {filteredEmployees.map((employee) => {
              const isSaving = savingEmployeeId === employee.id;
              const isResumeBusy = resumeBusyEmployeeId === employee.id;
              const department = employeeTSGDepartment(employee);
              const isExpanded = expandedEmployeeIds.has(employee.id);
              return (
                <article key={employee.id} className={`admin-hr-card${employee.is_hr_deleted ? " admin-hr-card--deleted" : ""}`}>
                  <button
                    type="button"
                    className="admin-hr-card__summary"
                    onClick={() => toggleEmployeeDetails(employee.id)}
                    aria-expanded={isExpanded}
                  >
                    <span className="admin-hr-card__summary-main">
                      <span className="admin-hr-card__name">{employee.real_name || employee.display_name}</span>
                      <span className="admin-hr-card__summary-meta" aria-label="社員情報">
                        <span className="admin-hr-summary-chip" title="社員NO">
                          <span aria-hidden="true">#</span>
                          <span>{employee.employee_code || "NO未設定"}</span>
                        </span>
                        <span className="admin-hr-summary-chip" title="勤務形態">
                          <span aria-hidden="true">⏱</span>
                          <span>{workStyleLabel(employee.work_style)}</span>
                        </span>
                        <span className="admin-hr-summary-chip" title="所属">
                          <span aria-hidden="true">{departmentIcon(department)}</span>
                          <span>{department}</span>
                        </span>
                        {employee.hr_profile.provisional_hire && (
                          <span className="admin-hr-summary-chip" title="入社予定">
                            <span aria-hidden="true">◷</span>
                            <span>仮入社{employee.hire_date ? ` ${formatOptionalDate(employee.hire_date)}` : ""}</span>
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="admin-hr-card__summary-icon" aria-hidden="true">{isExpanded ? "⌃" : "⌄"}</span>
                  </button>

                  {isExpanded && (
                    <div className="admin-hr-card__details">
                      <div className="admin-hr-card__identity">
                        <div>
                          <h4>{employee.real_name || employee.display_name}</h4>
                          <p>
                            {employee.employee_code ? `社員コード ${employee.employee_code}` : "社員コード未設定"}
                            {" / "}
                            {department}
                            {" / "}
                            {workStyleLabel(employee.work_style)}
                            {employee.hire_date ? ` / 入社日 ${formatOptionalDate(employee.hire_date)}` : ""}
                          </p>
                        </div>
                        <span className={`admin-link-status${employee.is_hr_deleted ? " admin-link-status--retired" : employee.user_id ? " admin-link-status--linked" : ""}`}>
                          {employee.is_hr_deleted ? "人事削除済" : employee.hr_profile.provisional_hire ? "仮入社（LINE未連携）" : employee.user_id ? "TSG連携済" : "TSG未連携"}
                        </span>
                      </div>

                      <div className="admin-work-style" role="group" aria-label={`${employee.real_name || employee.display_name} の就業形態`}>
                        {WORK_STYLE_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`admin-work-style__btn${employee.work_style === option.value ? " admin-work-style__btn--active" : ""}`}
                            onClick={() => updateHREmployee(employee, { work_style: option.value })}
                            disabled={isSaving || employee.is_hr_deleted}
                            aria-pressed={employee.work_style === option.value}
                          >
                            <span>{option.label}</span>
                            <small>{option.detail}</small>
                          </button>
                        ))}
                      </div>

                      <div className="admin-hr-core-grid">
                        <label className="admin-hr-field">
                          <span>社員NO（自動発行）</span>
                          <input
                            className="form-input"
                            value={employee.employee_code || "在籍連携時に自動発行"}
                            readOnly
                            aria-readonly="true"
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>入社日</span>
                          <input
                            type="date"
                            className="form-input"
                            value={coreDraftValue(employee, "hire_date")}
                            onChange={(event) => updateCoreDraft(employee, "hire_date", event.target.value)}
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>氏名カナ</span>
                          <input
                            className="form-input"
                            value={coreDraftValue(employee, "kana")}
                            onChange={(event) => updateCoreDraft(employee, "kana", event.target.value)}
                            placeholder="サトウ タロウ"
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>生年月日</span>
                          <input
                            type="date"
                            className="form-input"
                            value={coreDraftValue(employee, "birth_date")}
                            onChange={(event) => updateCoreDraft(employee, "birth_date", event.target.value)}
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>性別</span>
                          <select
                            className="form-input"
                            value={coreDraftValue(employee, "gender")}
                            onChange={(event) => updateCoreDraft(employee, "gender", event.target.value)}
                            disabled={isSaving || employee.is_hr_deleted}
                          >
                            <option value="">未設定</option>
                            <option value="female">女性</option>
                            <option value="male">男性</option>
                            <option value="other">その他</option>
                            <option value="unknown">回答なし</option>
                          </select>
                        </label>
                        <label className="admin-hr-field">
                          <span>基本勤務 開始</span>
                          <input
                            type="time"
                            className="form-input"
                            value={coreDraftValue(employee, "basic_work_start")}
                            onChange={(event) => updateCoreDraft(employee, "basic_work_start", event.target.value)}
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>基本勤務 終了</span>
                          <input
                            type="time"
                            className="form-input"
                            value={coreDraftValue(employee, "basic_work_end")}
                            onChange={(event) => updateCoreDraft(employee, "basic_work_end", event.target.value)}
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field">
                          <span>基本休憩（分）</span>
                          <input
                            type="number"
                            min="0"
                            max="480"
                            step="15"
                            inputMode="numeric"
                            className="form-input"
                            value={coreDraftValue(employee, "basic_break_minutes")}
                            onChange={(event) => updateCoreDraft(employee, "basic_break_minutes", event.target.value)}
                            placeholder="例: 45"
                            disabled={isSaving || employee.is_hr_deleted}
                          />
                        </label>
                        <button
                          type="button"
                          className="admin-btn-outline admin-hr-core-grid__save"
                          onClick={() => updateHREmployee(employee, {
                            hire_date: coreDraftValue(employee, "hire_date"),
                            kana: coreDraftValue(employee, "kana"),
                            birth_date: coreDraftValue(employee, "birth_date"),
                            gender: coreDraftValue(employee, "gender"),
                            basic_work_start: coreDraftValue(employee, "basic_work_start"),
                            basic_work_end: coreDraftValue(employee, "basic_work_end"),
                            basic_break_minutes: coreDraftValue(employee, "basic_break_minutes"),
                          })}
                          disabled={isSaving || employee.is_hr_deleted}
                        >
                          基本情報・勤務時間を保存
                        </button>
                      </div>

                      <div className="admin-hr-card__controls">
                        <select
                          className="admin-select"
                          value={employee.payroll_status}
                          disabled={isSaving || employee.is_hr_deleted || employee.payroll_status === "retired"}
                          onChange={(event) => updateHREmployee(employee, { payroll_status: event.target.value })}
                        >
                          <option value="active">在籍</option>
                          <option value="inactive">停止</option>
                          {employee.payroll_status === "retired" && <option value="retired">退職</option>}
                        </select>
                        <select
                          className="admin-select"
                          value={employee.user_id || ""}
                          disabled={isSaving || employee.is_hr_deleted}
                          onChange={(event) => updateHREmployee(employee, { user_id: event.target.value || null })}
                        >
                          <option value="">TSG未連携</option>
                          {hrUsers.map((user) => (
                            <option
                              key={user.id}
                              value={user.id}
                              disabled={user.id !== employee.user_id && linkedUserIds.has(user.id)}
                            >
                              {user.real_name || user.display_name}
                              {user.department ? ` / ${user.department}` : ""}
                            </option>
                          ))}
                        </select>
                        <input
                          type="date"
                          className="form-input"
                          value={employee.resigned_date || ""}
                          disabled
                          title="退職日は退職処理ボタンから設定します"
                        />
                      </div>

                      <section className="admin-hr-resume" aria-label={`${employee.real_name || employee.display_name}の履歴書`}>
                        <div className="admin-hr-resume__main">
                          <FileText size={22} aria-hidden="true" />
                          <div>
                            <strong>履歴書PDF</strong>
                            {employee.resume_document ? (
                              <>
                                <p>{employee.resume_document.file_name} / {formatFileSize(employee.resume_document.file_size)}</p>
                                <p>
                                  <span className={`admin-hr-resume__status admin-hr-resume__status--${employee.resume_document.ocr_status}`}>
                                    {resumeOcrStatusLabel(employee.resume_document.ocr_status)}
                                  </span>
                                  <span>{formatOptionalDate(employee.resume_document.processed_at || employee.resume_document.created_at)}</span>
                                </p>
                              </>
                            ) : (
                              <p>未登録。PDF保存後、AI OCRで空欄の人事情報を補完します。</p>
                            )}
                          </div>
                        </div>
                        <div className="admin-hr-resume__actions">
                          <label className={`admin-btn-accent admin-hr-resume__upload${isResumeBusy || employee.is_hr_deleted ? " admin-hr-resume__upload--disabled" : ""}`}>
                            <Upload size={15} aria-hidden="true" />
                            <span>{employee.resume_document ? "PDF差し替え" : "PDFアップロード"}</span>
                            <input
                              type="file"
                              accept="application/pdf,.pdf"
                              disabled={isResumeBusy || employee.is_hr_deleted}
                              onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = "";
                                if (file) void uploadResume(employee, file);
                              }}
                            />
                          </label>
                          {employee.resume_document && (
                            <a
                              className="admin-btn-outline admin-hr-resume__action"
                              href={`/api/admin/hr/resumes?document_id=${encodeURIComponent(employee.resume_document.id)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink size={15} aria-hidden="true" />
                              <span>PDFを開く</span>
                            </a>
                          )}
                          {employee.resume_document?.ocr_status === "failed" && (
                            <button
                              type="button"
                              className="admin-btn-outline admin-hr-resume__action"
                              onClick={() => void retryResumeOcr(employee)}
                              disabled={isResumeBusy || employee.is_hr_deleted}
                            >
                              <RefreshCw size={15} aria-hidden="true" />
                              <span>AI読取を再実行</span>
                            </button>
                          )}
                          {employee.resume_document && (
                            <button
                              type="button"
                              className="admin-btn-danger admin-hr-resume__action"
                              onClick={() => void deleteResume(employee)}
                              disabled={isResumeBusy || employee.is_hr_deleted}
                              title="履歴書PDFを削除"
                            >
                              <Trash2 size={15} aria-hidden="true" />
                              <span>削除</span>
                            </button>
                          )}
                        </div>
                        {(resumeMessages[employee.id] || employee.resume_document?.ocr_error) && (
                          <p className={`admin-hr-resume__message${employee.resume_document?.ocr_status === "failed" ? " admin-hr-resume__message--error" : ""}`}>
                            {resumeMessages[employee.id] || employee.resume_document?.ocr_error}
                          </p>
                        )}
                        {!!employee.resume_document?.extracted_data?.warnings?.length && (
                          <p className="admin-hr-resume__message admin-hr-resume__message--warning">
                            {employee.resume_document.extracted_data.warnings.join(" / ")}
                          </p>
                        )}
                      </section>

                      <div className="admin-hr-profile-grid">
                        <label className="admin-hr-field">
                          <span>電話番号</span>
                          <input className="form-input" value={draftValue(employee, "phone")} onChange={(event) => updateDraft(employee, "phone", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field">
                          <span>メール</span>
                          <input type="email" className="form-input" value={draftValue(employee, "email")} onChange={(event) => updateDraft(employee, "email", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field">
                          <span>郵便番号</span>
                          <input className="form-input" value={draftValue(employee, "postal_code")} onChange={(event) => updateDraft(employee, "postal_code", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__wide">
                          <span>住所</span>
                          <input className="form-input" value={draftValue(employee, "address")} onChange={(event) => updateDraft(employee, "address", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field">
                          <span>緊急連絡先名</span>
                          <input className="form-input" value={draftValue(employee, "emergency_contact_name")} onChange={(event) => updateDraft(employee, "emergency_contact_name", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field">
                          <span>緊急連絡先電話</span>
                          <input className="form-input" value={draftValue(employee, "emergency_contact_phone")} onChange={(event) => updateDraft(employee, "emergency_contact_phone", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>学歴</span>
                          <textarea className="form-input" rows={3} value={draftValue(employee, "education_history")} onChange={(event) => updateDraft(employee, "education_history", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>職歴</span>
                          <textarea className="form-input" rows={4} value={draftValue(employee, "work_history")} onChange={(event) => updateDraft(employee, "work_history", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>免許・資格</span>
                          <textarea className="form-input" rows={3} value={draftValue(employee, "qualifications")} onChange={(event) => updateDraft(employee, "qualifications", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>志望動機・自己PR</span>
                          <textarea className="form-input" rows={3} value={draftValue(employee, "personal_statement")} onChange={(event) => updateDraft(employee, "personal_statement", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>履歴書の補足情報</span>
                          <textarea className="form-input" rows={2} value={draftValue(employee, "resume_notes")} onChange={(event) => updateDraft(employee, "resume_notes", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>採用連絡メール内容</span>
                          <textarea
                            className="form-input"
                            rows={8}
                            placeholder="採用連絡メールの件名・本文を貼り付け"
                            value={draftValue(employee, "hiring_contact_email_content")}
                            onChange={(event) => updateDraft(employee, "hiring_contact_email_content", event.target.value)}
                            disabled={employee.is_hr_deleted}
                          />
                        </label>
                        <label className="admin-hr-field admin-hr-profile-grid__full">
                          <span>人事メモ</span>
                          <textarea className="form-input" rows={3} value={draftValue(employee, "memo")} onChange={(event) => updateDraft(employee, "memo", event.target.value)} disabled={employee.is_hr_deleted} />
                        </label>
                      </div>

                      <div className="admin-hr-card__footer">
                        <span>給与明細 {employee.payroll_result_count}件</span>
                        <div>
                          <button
                            type="button"
                            className="admin-btn-outline"
                            onClick={() => updateHREmployee(employee, { hr_profile: drafts[employee.id] || employee.hr_profile || {} })}
                            disabled={isSaving || employee.is_hr_deleted}
                          >
                            人事情報保存
                          </button>
                          <button
                            type="button"
                            className="admin-btn-outline"
                            onClick={() => void retireEmployee(employee)}
                            disabled={isSaving || employee.is_hr_deleted || employee.payroll_status === "retired"}
                            title="ログインを停止し、給与・勤怠・投稿履歴は保持します"
                          >
                            退職処理
                          </button>
                          <button
                            type="button"
                            className="admin-btn-danger"
                            onClick={() => deleteRetiredEmployee(employee)}
                            disabled={isSaving || employee.is_hr_deleted || employee.payroll_status !== "retired"}
                            title="給与・勤怠を保持したまま、人事の個人情報とTSG連携を削除します"
                          >
                            個人情報を削除
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── 労務データタブ ───
function LaborDataAdminTab() {
  const [payload, setPayload] = useState<LaborImportsPayload | null>(null);
  const [diffPayload, setDiffPayload] = useState<PayrollDiffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [uploadPayrollMonth, setUploadPayrollMonth] = useState(currentMonthInputValue());
  const [uploadAttendanceMonth, setUploadAttendanceMonth] = useState(currentMonthInputValue(-1));
  const [uploadPayrollKind, setUploadPayrollKind] = useState("monthly");
  const [uploadMessage, setUploadMessage] = useState("");
  const [zipInputKey, setZipInputKey] = useState(0);
  const [selectedDiffPeriodId, setSelectedDiffPeriodId] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [showMatchedDiffRows, setShowMatchedDiffRows] = useState(false);
  const [diffDetailLimit, setDiffDetailLimit] = useState(12);
  const [linkingAliasKey, setLinkingAliasKey] = useState("");
  const [analyzingBatchId, setAnalyzingBatchId] = useState("");

  function loadImports() {
    setLoading(true);
    fetch("/api/admin/labor/imports", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((nextPayload: LaborImportsPayload) => setPayload(nextPayload))
      .catch(() => setPayload(null))
      .finally(() => setLoading(false));
  }

  function loadDiff(periodId = selectedDiffPeriodId, payrollMonth = "", payrollKind = "") {
    setDiffLoading(true);
    const params = new URLSearchParams();
    if (periodId) params.set("periodId", periodId);
    if (payrollMonth) params.set("payrollMonth", payrollMonth);
    if (payrollKind) params.set("payrollKind", payrollKind);
    const query = params.size ? `?${params.toString()}` : "";
    fetch(`/api/admin/payroll/diff${query}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((nextPayload: PayrollDiffPayload) => {
        setDiffPayload(nextPayload);
        setSelectedDiffPeriodId(nextPayload.selectedPeriod?.id || "");
      })
      .catch(() => setDiffPayload(null))
      .finally(() => setDiffLoading(false));
  }

  async function reconcileImportPeriods() {
    try {
      await fetch("/api/admin/labor/imports/reconcile", { method: "POST" });
    } catch {
      // The following reads still provide the existing periods if reconciliation is temporarily unavailable.
    }
  }

  function refreshLaborWorkspace(periodId = selectedDiffPeriodId) {
    void reconcileImportPeriods().finally(() => {
      loadImports();
      loadDiff(periodId);
    });
  }

  async function handleEmployeeAliasLink(
    row: PayrollDiffRow,
    candidate: PayrollDiffRow["laborCandidates"][number],
  ) {
    if (!candidate.sourceEmployeeId) return;
    if (!confirm(`「${candidate.sourceEmployeeName}」を「${row.employeeName}」の労務士名として登録しますか？\n今後は同一人物として自動で比較します。`)) return;

    const key = `${row.employeeId}:${candidate.sourceEmployeeId}`;
    setLinkingAliasKey(key);
    try {
      const response = await fetch("/api/admin/payroll/employee-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetEmployeeId: row.employeeId,
          sourceEmployeeId: candidate.sourceEmployeeId,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "社員名の紐付けに失敗しました");
      loadDiff(selectedDiffPeriodId);
    } catch (error) {
      alert(error instanceof Error ? error.message : "社員名の紐付けに失敗しました");
    } finally {
      setLinkingAliasKey("");
    }
  }

  async function handleZipUpload() {
    if (!zipFile) {
      setUploadMessage("ZIPファイルを選択してください。");
      return;
    }
    const formData = new FormData();
    formData.set("file", zipFile);
    formData.set("payrollMonth", uploadPayrollMonth);
    formData.set("attendanceMonth", uploadAttendanceMonth);
    formData.set("payrollKind", uploadPayrollKind);

    setUploading(true);
    setUploadMessage("");
    try {
      const response = await fetch("/api/admin/labor/imports/upload", {
        method: "POST",
        body: formData,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "ZIP取込に失敗しました");
      }
      const entryCount = Number(result.summary?.entryCount || 0);
      const driveNote = result.driveUploaded ? "Drive保管済み" : "Drive保管は未完了";
      if (result.analysis) {
        setUploadMessage(`解析完了: ${result.analysis.employeeCount}名 / 支給 ${formatCurrency(result.analysis.paymentTotal)} / 控除 ${formatCurrency(result.analysis.deductionTotal)} / 差引 ${formatCurrency(result.analysis.netPayment)}。原本全社計と一致しました。`);
      } else {
        setUploadMessage(`ZIPを登録しました。対象 ${entryCount}件 / ${driveNote}。解析エラー: ${result.analysisError || "原因を確認してください"}`);
      }
      setZipFile(null);
      setZipInputKey((key) => key + 1);
      loadImports();
      loadDiff("", uploadPayrollMonth, uploadPayrollKind);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "ZIP取込に失敗しました");
    } finally {
      setUploading(false);
    }
  }

  async function handleAnalyzeBatch(batchId: string) {
    setAnalyzingBatchId(batchId);
    setUploadMessage("");
    try {
      const response = await fetch(`/api/admin/labor/imports/${encodeURIComponent(batchId)}/analyze`, {
        method: "POST",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "労務ZIPの解析に失敗しました");
      setUploadMessage(`解析完了: ${result.employeeCount}名 / 支給 ${formatCurrency(result.paymentTotal)} / 控除 ${formatCurrency(result.deductionTotal)} / 差引 ${formatCurrency(result.netPayment)}。原本全社計と一致しました。`);
      refreshLaborWorkspace(selectedDiffPeriodId);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "労務ZIPの解析に失敗しました");
    } finally {
      setAnalyzingBatchId("");
    }
  }

  useEffect(() => {
    refreshLaborWorkspace("");
  }, []);

  const documents = payload?.documents || [];
  const filteredDocuments = documents.filter((document) => {
    const keyword = filter.trim();
    if (!keyword) return true;
    return [
      document.file_name,
      document.relative_path,
      document.document_type,
      document.extraction_status,
      document.extraction_notes,
    ].some((value) => (value || "").includes(keyword));
  });
  const visibleDocuments = filteredDocuments.slice(0, filter.trim() ? 60 : 24);
  const unresolvedDiffRows = (diffPayload?.rows || []).filter((row) => row.issue !== "一致");
  const visibleDiffRows = showMatchedDiffRows ? (diffPayload?.rows || []) : unresolvedDiffRows;
  const selectedPayrollMonth = diffPayload?.selectedPeriod?.payrollMonth || null;
  const selectedMonthDocuments = selectedPayrollMonth
    ? documents.filter((document) => document.target_payroll_month === selectedPayrollMonth)
    : [];
  const selectedMonthPendingDocuments = selectedMonthDocuments.filter((document) => document.extraction_status === "pending").length;
  const selectedMonthFailedDocuments = selectedMonthDocuments.filter((document) => document.extraction_status === "failed").length;
  const selectedLaborBatch = (payload?.batches || []).find((batch) => (
    batch.target_payroll_month === selectedPayrollMonth
    && batch.payroll_kind === diffPayload?.selectedPeriod?.payrollKind
  )) || null;

  return (
    <div className="admin-labor">
      <section className="admin-payroll-heading">
        <div>
          <span className="admin-payroll-kicker">Payroll Verification</span>
          <h3 className="admin-section-title">労務士計算との検証</h3>
          <p>労務士の確定給与を基準に社内計算との差を特定し、給与ロジックを段階的に合わせます。</p>
        </div>
        <div className="admin-payroll-heading__actions">
          <button
            type="button"
            className="admin-btn-outline"
            onClick={() => {
              refreshLaborWorkspace();
            }}
            disabled={loading || diffLoading}
          >
            <RefreshCw size={16} aria-hidden="true" />
            再検証
          </button>
        </div>
      </section>

      <section className="admin-payroll-card admin-labor-upload">
        <div className="admin-payroll-card__header">
          <div>
            <h4>労務士ZIP取込</h4>
            <p>毎月届くZIPを登録し、勤務対象月と支給日を明確にして社内計算と検証します。</p>
          </div>
        </div>
        <div className="admin-labor-upload__body">
          <div className="admin-labor-upload__periods">
            <label>
              <span>支給月</span>
              <input
                type="month"
                className="form-input"
                value={uploadPayrollMonth}
                onChange={(event) => setUploadPayrollMonth(event.target.value)}
              />
            </label>
            <label>
              <span>勤務対象月</span>
              <input
                type="month"
                className="form-input"
                value={uploadAttendanceMonth}
                onChange={(event) => setUploadAttendanceMonth(event.target.value)}
              />
            </label>
            <label>
              <span>種別</span>
              <select
                className="admin-select"
                value={uploadPayrollKind}
                onChange={(event) => setUploadPayrollKind(event.target.value)}
              >
                <option value="monthly">給与</option>
                <option value="bonus">賞与</option>
                <option value="adjustment">調整</option>
              </select>
            </label>
          </div>

          <div className="admin-labor-upload__file-row">
            <label className="admin-labor-upload__file" htmlFor="labor-zip-file">
              <input
                key={zipInputKey}
                id="labor-zip-file"
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={(event) => setZipFile(event.target.files?.[0] || null)}
              />
              <span className="admin-labor-upload__file-icon">ZIP</span>
              <span className="admin-labor-upload__file-main">
                <strong>{zipFile ? zipFile.name : "ZIPファイルを選択"}</strong>
                <small>{zipFile ? formatFileSize(zipFile.size) : "PDF / Excel / CSVが入った労務士ZIP"}</small>
              </span>
            </label>
            <button type="button" className="admin-btn-accent admin-labor-upload__submit" onClick={handleZipUpload} disabled={uploading}>
              {uploading ? "取込中..." : "登録"}
            </button>
          </div>
        </div>
        <p className="admin-labor-upload__note">
          例: 7月勤務分を8月10日に支給する場合は、支給月「2026-08」・勤務対象月「2026-07」です。<br />
          支給控除一覧表・事業所負担保険料一覧表・賃金台帳はExcel/CSVを優先解析します。PDFと全原文は監査用に保持し、通常は下の検証結果だけを確認します。
        </p>
        {uploadMessage && <p className="admin-labor-upload__message">{uploadMessage}</p>}
      </section>

      <section className="admin-payroll-card admin-payroll-review">
        <div className="admin-payroll-card__header admin-payroll-review__header">
          <div>
            <span className="admin-payroll-kicker">Verification Result</span>
            <h4>検証結果と変更ポイント</h4>
            <p>先に比較不能の原因を解消し、その後に金額差がある計算項目を労務士ロジックへ合わせます。</p>
          </div>
          <select
            className="admin-select"
            value={selectedDiffPeriodId}
            onChange={(event) => {
              setSelectedDiffPeriodId(event.target.value);
              setShowMatchedDiffRows(false);
              setDiffDetailLimit(12);
              loadDiff(event.target.value);
            }}
            disabled={diffLoading}
            aria-label="検証する給与月"
          >
            {(diffPayload?.periods || []).map((period) => (
              <option key={period.id} value={period.id}>
                {formatLaborPayrollPeriod(period.attendanceMonth, period.payDate, period.payrollMonth, period.payrollKindLabel)}
              </option>
            ))}
          </select>
          {selectedLaborBatch && (
            <button
              type="button"
              className="admin-btn-accent"
              onClick={() => handleAnalyzeBatch(selectedLaborBatch.id)}
              disabled={Boolean(analyzingBatchId)}
            >
              {analyzingBatchId === selectedLaborBatch.id
                ? "解析中..."
                : selectedMonthPendingDocuments > 0
                  ? "ZIPを解析"
                  : "ZIPを再解析"}
            </button>
          )}
        </div>

        {diffLoading ? (
          <p className="admin-empty">労務士結果と社内計算を検証中...</p>
        ) : !diffPayload ? (
          <p className="admin-empty">検証データを読み込めませんでした</p>
        ) : diffPayload.requestedPeriodMissing ? (
          <p className="admin-empty">指定した給与月はまだ登録されていません。ZIPを登録すると、その月の解析待ち状況がここに表示されます。</p>
        ) : (
          <>
            <div className={`admin-payroll-review__status admin-payroll-review__status--${diffPayload.review.status}`}>
              {diffPayload.review.status === "verified" ? (
                <CheckCircle2 size={24} aria-hidden="true" />
              ) : (
                <AlertTriangle size={24} aria-hidden="true" />
              )}
              <div>
                <strong>{diffPayload.review.statusLabel}</strong>
                <span>{diffPayload.review.headline}</span>
              </div>
            </div>

            <div className="admin-payroll-review__metrics">
              <div><span>比較可能</span><strong>{diffPayload.summary.compared} / {diffPayload.summary.employees}人</strong><em>{diffPayload.review.readinessPercent}%</em></div>
              <div><span>主要項目一致</span><strong>{diffPayload.review.exactMatches}人</strong><em>変更不要</em></div>
              <div><span>未解決</span><strong>{diffPayload.review.unresolvedEmployees}人</strong><em>社員別に確認</em></div>
              <div><span>支給差合計</span><strong>{formatCurrency(diffPayload.summary.paymentDeltaTotal)}</strong><em>自社 - 労務士</em></div>
            </div>

            {(selectedMonthPendingDocuments > 0 || selectedMonthFailedDocuments > 0) && (
              <div className="admin-payroll-review__source-warning">
                <AlertTriangle size={18} aria-hidden="true" />
                <span>
                  この給与月の原文は解析待ち {selectedMonthPendingDocuments}件、失敗 {selectedMonthFailedDocuments}件です。
                  明細抽出が終わるまでは変更ポイントが増減する可能性があります。
                </span>
              </div>
            )}

            <div className="admin-payroll-review__change-points">
              {diffPayload.review.changePoints.length === 0 ? (
                <div className="admin-payroll-review__clear">
                  <CheckCircle2 size={20} aria-hidden="true" />
                  <span>現在取得できている主要項目に変更候補はありません。</span>
                </div>
              ) : diffPayload.review.changePoints.map((changePoint) => (
                <article key={changePoint.id} className={`admin-payroll-review-point admin-payroll-review-point--${changePoint.priority}`}>
                  <div className="admin-payroll-review-point__head">
                    <span>{changePoint.priority === "blocker" ? "先に解消" : changePoint.priority === "high" ? "優先修正" : "確認候補"}</span>
                    <strong>{changePoint.label}</strong>
                    <b>{changePoint.affectedEmployees}人</b>
                  </div>
                  <p>{changePoint.diagnosis}</p>
                  <div className="admin-payroll-review-point__action">
                    <Wrench size={16} aria-hidden="true" />
                    <span><b>変更先:</b> {changePoint.target}<br />{changePoint.action}</span>
                  </div>
                  {changePoint.absoluteDeltaTotal > 0 && (
                    <div className="admin-payroll-review-point__delta">
                      <span>差額規模 {formatCurrency(changePoint.absoluteDeltaTotal)}</span>
                      <span>差額合計 {formatCurrency(changePoint.signedDeltaTotal)}</span>
                    </div>
                  )}
                  <small>対象: {changePoint.employeeNames.join("、")}{changePoint.affectedEmployees > changePoint.employeeNames.length ? " ほか" : ""}</small>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="admin-payroll-card admin-payroll-diff">
        <div className="admin-payroll-card__header">
          <div>
            <h4>社員別の検証根拠</h4>
            <p>変更ポイントの根拠になった社員だけを表示します。一致した社員は通常は非表示です。</p>
          </div>
          {diffPayload && diffPayload.review.exactMatches > 0 && (
            <button
              type="button"
              className="admin-btn-outline"
              onClick={() => {
                setShowMatchedDiffRows((current) => !current);
                setDiffDetailLimit(12);
              }}
            >
              {showMatchedDiffRows ? "要確認だけ表示" : `全${diffPayload.rows.length}人を表示`}
            </button>
          )}
        </div>

        {diffLoading ? (
          <p className="admin-empty">社員別の差異を確認中...</p>
        ) : !diffPayload ? (
          <p className="admin-empty">社員別データを読み込めませんでした</p>
        ) : visibleDiffRows.length === 0 ? (
          <p className="admin-empty">要確認の社員はいません。</p>
        ) : (
          <div className="admin-payroll-diff-list">
            {visibleDiffRows.slice(0, diffDetailLimit).map((row) => {
                  const breakdownRows = row.laborBreakdown && row.calculatedBreakdown ? [
                    { label: "基本給・本給", labor: row.laborBreakdown.baseAmount, calculated: row.calculatedBreakdown.baseAmount },
                    { label: "残業・休日・深夜", labor: row.laborBreakdown.overtimeAmount, calculated: row.calculatedBreakdown.overtimeAmount },
                    { label: "手当・その他課税", labor: row.laborBreakdown.taxableAdditions, calculated: row.calculatedBreakdown.taxableAdditions },
                    { label: "非課税支給", labor: row.laborBreakdown.nonTaxableAmount, calculated: row.calculatedBreakdown.nonTaxableAmount },
                    { label: "控除", labor: row.laborBreakdown.deductionTotal, calculated: row.calculatedBreakdown.deductionTotal },
                  ].map((item) => ({ ...item, delta: item.calculated - item.labor })) : [];
                  const detailItems = [
                    ...(row.laborBreakdown?.earningItems || []),
                    ...(row.laborBreakdown?.deductionItems || []),
                    ...(row.laborBreakdown?.attendanceItems || []),
                  ];

              return (
                    <details key={row.employeeId} className={`admin-payroll-diff-card ${row.issue !== "一致" ? "admin-payroll-diff-card--mismatch" : ""}`}>
                      <summary className="admin-payroll-diff-card__summary">
                      <div className="admin-payroll-diff-card__head">
                        <span className="admin-payroll-diff__issue">{row.issue}</span>
                        <div>
                          <strong>{row.employeeName}</strong>
                          <span>{row.employeeCode || "-"} / {row.department || "-"}</span>
                        </div>
                      </div>
                        <span className="admin-payroll-diff-card__summary-delta">
                          支給差 {row.delta.paymentTotal === null ? "-" : formatCurrency(row.delta.paymentTotal)}
                        </span>
                        <ChevronDown size={18} aria-hidden="true" />
                      </summary>

                      <div className="admin-payroll-diff-card__body">

                      {(row.laborMatch && row.laborMatch.matchedBy !== "direct") || (!row.hasLaborResult && row.laborCandidates.length > 0) ? (
                        <div className="admin-payroll-diff-card__note">
                          {row.laborMatch && row.laborMatch.matchedBy !== "direct" && (
                            <span>突合: {row.laborMatch.sourceEmployeeName || "-"} / {row.laborMatch.sourceEmployeeCode || "-"} / {row.laborMatch.matchedByLabel}</span>
                          )}
                          {!row.hasLaborResult && row.laborCandidates.length > 0 && (
                            <div className="admin-payroll-diff-card__candidates">
                              <span>社員マスタの同一人物候補</span>
                              {row.laborCandidates.map((candidate) => {
                                const candidateKey = `${row.employeeId}:${candidate.sourceEmployeeId}`;
                                return (
                                  <button
                                    key={candidateKey}
                                    type="button"
                                    className="admin-btn-outline"
                                    onClick={() => handleEmployeeAliasLink(row, candidate)}
                                    disabled={!candidate.sourceEmployeeId || linkingAliasKey === candidateKey}
                                  >
                                    <Link2 size={14} aria-hidden="true" />
                                    {linkingAliasKey === candidateKey
                                      ? "登録中..."
                                      : `${candidate.sourceEmployeeName || "-"} (${candidate.sourceEmployeeCode || "社員NOなし"}) として登録`}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}

                      <div className="admin-payroll-diff-card__work">
                        <span>比較勤怠</span>
                        <strong>{row.workDays === null || row.workMinutes === null ? "打刻なし" : `${row.workDays}日 / ${formatPayrollMinutes(row.workMinutes)}`}</strong>
                        {row.attendanceSource === "labor_result" && <em>この月の労務士明細と同じ勤怠条件で計算</em>}
                        {row.attendanceSource === "labor_snapshot" && <em>過去設定の勤怠で計算</em>}
                      </div>

                      <div className="admin-payroll-diff-card__amounts">
                        <div>
                          <span>労務士支給</span>
                          <strong>{row.labor ? formatCurrency(row.labor.paymentTotal) : "-"}</strong>
                        </div>
                        <div>
                          <span>自社計算支給</span>
                          <strong>{row.calculated ? formatCurrency(row.calculated.paymentTotal) : "-"}</strong>
                        </div>
                        <div className={row.delta.paymentTotal === null || row.delta.paymentTotal === 0 ? "" : "admin-payroll-diff-card__delta"}>
                          <span>支給差</span>
                          <strong>{row.delta.paymentTotal === null ? "-" : formatCurrency(row.delta.paymentTotal)}</strong>
                        </div>
                        <div>
                          <span>労務士手取</span>
                          <strong>{row.labor ? formatCurrency(row.labor.netPayment) : "-"}</strong>
                        </div>
                        <div>
                          <span>自社計算手取</span>
                          <strong>{row.calculated ? formatCurrency(row.calculated.netPayment) : "-"}</strong>
                        </div>
                        <div className={row.delta.netPayment === null || row.delta.netPayment === 0 ? "" : "admin-payroll-diff-card__delta"}>
                          <span>手取差</span>
                          <strong>{row.delta.netPayment === null ? "-" : formatCurrency(row.delta.netPayment)}</strong>
                        </div>
                      </div>

                      {row.operational && (
                        <div className={`admin-payroll-diff-card__operational ${row.hasOperationalAttendanceDifference ? "admin-payroll-diff-card__operational--warning" : ""}`}>
                          <div>
                            <span>実打刻ベース試算</span>
                            <strong>{row.operational.workDays}日 / {formatPayrollMinutes(row.operational.workMinutes)}</strong>
                          </div>
                          <div>
                            <span>支給試算</span>
                            <strong>{formatCurrency(row.operational.paymentTotal)}</strong>
                          </div>
                          <div>
                            <span>確定額との差</span>
                            <strong>{formatCurrency(row.operational.paymentDelta || 0)}</strong>
                          </div>
                          {(row.attendanceDifferenceHints || []).map((hint) => <p key={hint}>{hint}</p>)}
                        </div>
                      )}

                      <div className="admin-payroll-diff-card__logic">
                        <span>差異理由</span>
                        {(row.differenceHints || ["主要内訳を確認できませんでした。"]).map((hint) => (
                          <strong key={hint}>{hint}</strong>
                        ))}
                      </div>

                      {breakdownRows.length > 0 && (
                        <div className="admin-payroll-diff-breakdown">
                          <div className="admin-payroll-diff-breakdown__header">
                            <span>内訳</span>
                            <span>労務士</span>
                            <span>自社</span>
                            <span>差</span>
                          </div>
                          {breakdownRows.map((item) => (
                            <div key={item.label} className={`admin-payroll-diff-breakdown__row ${Math.abs(item.delta) >= 1 ? "admin-payroll-diff-breakdown__row--delta" : ""}`}>
                              <span>{item.label}</span>
                              <strong>{formatCurrency(item.labor)}</strong>
                              <strong>{formatCurrency(item.calculated)}</strong>
                              <strong>{formatCurrency(item.delta)}</strong>
                            </div>
                          ))}
                        </div>
                      )}

                      {detailItems.length > 0 && (
                        <details className="admin-payroll-diff-details">
                          <summary>労務士明細を見る</summary>
                          <div>
                            {detailItems.map((item) => (
                              <p key={`${item.code}-${item.label}`}>
                                <span>{item.label}</span>
                                <strong>{formatCurrency(item.amount)}</strong>
                                {item.meta && <em>{item.meta}</em>}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                      </div>
                    </details>
              );
            })}
            {visibleDiffRows.length > diffDetailLimit && (
              <button
                type="button"
                className="admin-btn-outline admin-payroll-diff-list__more"
                onClick={() => setDiffDetailLimit((current) => current + 12)}
              >
                次の{Math.min(12, visibleDiffRows.length - diffDetailLimit)}人を表示
              </button>
            )}
          </div>
        )}
      </section>

      <details
        className="admin-payroll-card admin-labor-archive"
        open={archiveOpen}
        onToggle={(event) => setArchiveOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <FolderArchive size={18} aria-hidden="true" />
            <b>取込履歴・原文ファイル</b>
            <small>監査や再確認が必要な時だけ開きます</small>
          </span>
          <span className="admin-labor-archive__counts">
            {payload?.summary.batches ?? "-"}回 / {payload?.summary.documents ?? "-"}件
            <ChevronDown size={18} aria-hidden="true" />
          </span>
        </summary>

        {archiveOpen && (
          <div className="admin-labor-archive__body">
            {loading ? (
              <p className="admin-empty">取込履歴を読み込み中...</p>
            ) : !payload ? (
              <p className="admin-empty">取込履歴を読み込めませんでした</p>
            ) : (
              <>
                <div className="admin-labor-archive__summary">
                  <div><strong>{payload.summary.batches}</strong><span>取込回数</span></div>
                  <div><strong>{payload.summary.documents}</strong><span>原文</span></div>
                  <div><strong>{payload.summary.extracted}</strong><span>抽出済</span></div>
                  <div><strong>{payload.summary.failed}</strong><span>失敗</span></div>
                </div>

                <section className="admin-labor-archive__section">
                  <h5>最近の取込</h5>
                  <div className="admin-labor-card-list">
                    {payload.batches.slice(0, 8).map((batch) => (
                      <article key={batch.id} className="admin-labor-row-card">
                        <div className="admin-labor-row-card__main">
                          <strong>{formatLaborPayrollPeriod(batch.target_attendance_month, batch.pay_date, batch.target_payroll_month, batch.payrollKindLabel)}</strong>
                          <span>支給日 {formatOptionalDate(batch.pay_date)} / 状態 {batch.status}</span>
                        </div>
                        <div className="admin-labor-row-card__metrics">
                          <span><b>{batch.documentCount}</b>原文</span>
                          <span><b>{batch.extractedCount}</b>抽出済</span>
                          <span><b>{batch.failedCount}</b>失敗</span>
                          <span><b>{formatFileSize(batch.totalFileSize)}</b>容量</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="admin-labor-archive__section">
                  <div className="admin-labor-archive__section-head">
                    <div>
                      <h5>原文を探す</h5>
                      <p>通常は確認不要です。ファイル名・種別・状態で絞り込みます。</p>
                    </div>
                    <input
                      type="search"
                      className="form-input admin-labor-search"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="原文を検索"
                    />
                  </div>
                  <div className="admin-labor-card-list">
                    {visibleDocuments.map((document) => (
                      <article key={document.id} className="admin-labor-row-card admin-labor-row-card--document">
                        <div className="admin-labor-row-card__main">
                          <strong>{document.file_name}</strong>
                          <span>{formatOptionalDate(document.target_payroll_month)} / {document.document_type || "-"} / {extractionStatusLabel(document.extraction_status)}</span>
                        </div>
                        <div className="admin-labor-row-card__metrics">
                          <span><b>{formatFileSize(document.fileSize)}</b>サイズ</span>
                          <span><b>{document.file_extension || "-"}</b>形式</span>
                        </div>
                        {document.extraction_notes && <p className="admin-labor-row-card__note">{document.extraction_notes}</p>}
                      </article>
                    ))}
                  </div>
                  {filteredDocuments.length > visibleDocuments.length && (
                    <p className="admin-labor-archive__limit">{filteredDocuments.length}件中、先頭{visibleDocuments.length}件を表示しています。検索で絞り込んでください。</p>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

function ManualAdminTab({ canManageAttendance }: { canManageAttendance: boolean }) {
  const [manual, setManual] = useState<"paid-leave" | "attendance">(
    canManageAttendance ? "attendance" : "paid-leave",
  );

  return (
    <div className="manual-hub">
      <div className="manual-hub__switch no-print" role="tablist" aria-label="マニュアルを選択">
        <button
          type="button"
          role="tab"
          aria-selected={manual === "paid-leave"}
          className={manual === "paid-leave" ? "is-active" : ""}
          onClick={() => setManual("paid-leave")}
        >
          <Sprout size={18} aria-hidden="true" />
          休暇申請
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={manual === "attendance"}
          className={manual === "attendance" ? "is-active" : ""}
          onClick={() => setManual("attendance")}
        >
          <Clock3 size={18} aria-hidden="true" />
          勤怠・打刻
        </button>
      </div>
      {manual === "paid-leave" ? <PaidLeaveOperationManual /> : <AttendanceOperationManual />}
    </div>
  );
}

function PersonalPaidLeaveTab() {
  return (
    <section className="admin-panel">
      <span className="admin-eyebrow">Paid Leave</span>
      <h3 className="admin-section-title">有給申請</h3>
      <p className="admin-section-description">有給残日数の確認と、全休・半休の申請を行います。</p>
      <a className="btn-primary" href="/leave">有給申請を開く</a>
    </section>
  );
}

function LeaveManagementHub({ permissions }: { permissions: ManagementPermissions }) {
  const canShowPaidLeave = permissions.canManageAttendance || permissions.canUsePersonalLeave;
  const canShowBereavement = permissions.canManageAttendance || permissions.canUseBereavementLeave;
  const [section, setSection] = useState<"paid" | "bereavement">(
    canShowPaidLeave ? "paid" : "bereavement",
  );
  const [paidMode, setPaidMode] = useState<"personal" | "admin">(
    permissions.canUsePersonalLeave ? "personal" : "admin",
  );

  return (
    <div className="leave-management-hub">
      {canShowPaidLeave && canShowBereavement && (
        <div className="leave-management-switch" role="tablist" aria-label="休暇管理を選択">
          <button
            type="button"
            role="tab"
            aria-selected={section === "paid"}
            className={section === "paid" ? "is-active" : ""}
            onClick={() => setSection("paid")}
          >
            <Sprout size={17} aria-hidden="true" />
            {permissions.canManageAttendance ? "有給・欠勤" : "有給申請"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "bereavement"}
            className={section === "bereavement" ? "is-active" : ""}
            onClick={() => setSection("bereavement")}
          >
            <HeartHandshake size={17} aria-hidden="true" />
            忌引き休暇
          </button>
        </div>
      )}
      {section === "paid" && canShowPaidLeave && (
        <>
          {permissions.canManageAttendance && permissions.canUsePersonalLeave && (
            <div className="leave-management-switch" role="tablist" aria-label="有給画面を選択">
              <button
                type="button"
                role="tab"
                aria-selected={paidMode === "personal"}
                className={paidMode === "personal" ? "is-active" : ""}
                onClick={() => setPaidMode("personal")}
              >
                <Sprout size={17} aria-hidden="true" />
                自分の申請
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={paidMode === "admin"}
                className={paidMode === "admin" ? "is-active" : ""}
                onClick={() => setPaidMode("admin")}
              >
                <UsersRound size={17} aria-hidden="true" />
                全員管理
              </button>
            </div>
          )}
          {permissions.canManageAttendance && paidMode === "admin"
            ? <PaidLeaveAdminTab />
            : <PersonalPaidLeaveTab />}
        </>
      )}
      {section === "bereavement" && canShowBereavement && <BereavementLeaveTab />}
    </div>
  );
}

// ─── メインページ ───
export default function AdminPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<ManagementPermissions | null>(null);
  const [tab, setTab] = useState<Tab>("users");
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const nextPermissions = data?.permissions as ManagementPermissions | undefined;
        if (!data?.user || !nextPermissions?.canUseAdmin) {
          router.replace("/groups");
          return;
        }
        setCurrentUser(data.user);
        setPermissions(nextPermissions);
        if (!nextPermissions.canManageUsers) {
          if (nextPermissions.canViewPayroll) setTab("payroll");
          else if (nextPermissions.canManageAttendance) setTab("attendance");
          else if (nextPermissions.canUsePersonalLeave) setTab("leave");
          else if (nextPermissions.canUseManual) setTab("manual");
        }
        setAuthChecking(false);
      })
      .catch(() => router.replace("/groups"));
  }, [router]);

  if (authChecking) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-sub)" }}>
        読み込み中...
      </div>
    );
  }

  const managementRoles: readonly UserRole[] = ["executive", "admin"];
  const allRoles: readonly UserRole[] = ["executive", "admin", "member"];
  const executiveRoles: readonly UserRole[] = ["executive"];
  const availableTabs: {
    id: Tab;
    label: string;
    visible: boolean;
    roles: readonly UserRole[];
    Icon: LucideIcon;
  }[] = [
    { id: "users", label: "ユーザー", visible: !!permissions?.canManageUsers, roles: managementRoles, Icon: UserRound },
    { id: "groups", label: "グループ", visible: !!permissions?.canManageGroups, roles: managementRoles, Icon: UsersRound },
    { id: "attendance", label: "勤怠", visible: !!permissions?.canManageAttendance, roles: managementRoles, Icon: Clock3 },
    {
      id: "leave",
      label: permissions?.canManageAttendance
        ? "休暇・欠勤"
        : permissions?.canUseBereavementLeave
          ? "休暇申請"
          : "有給申請",
      visible: !!permissions?.canManageAttendance
        || !!permissions?.canUsePersonalLeave
        || !!permissions?.canUseBereavementLeave,
      roles: allRoles,
      Icon: Sprout,
    },
    { id: "shifts", label: "シフト", visible: !!permissions?.canManageAttendance, roles: managementRoles, Icon: CalendarDays },
    { id: "pledges", label: "誓約", visible: !!permissions?.canManageUsers, roles: managementRoles, Icon: FileSignature },
    { id: "payroll", label: "給与・労務", visible: !!permissions?.canViewPayroll, roles: executiveRoles, Icon: Banknote },
    { id: "hr", label: "人事管理", visible: !!permissions?.canViewPayroll, roles: executiveRoles, Icon: ContactRound },
    {
      id: "manual",
      label: "マニュアル",
      visible: !!permissions?.canUseManual,
      roles: allRoles,
      Icon: BookOpenCheck,
    },
  ];

  const visibleTabs = availableTabs.filter((item) => item.visible);

  return (
    <>
      <header className="top-header" role="banner">
        <button type="button" className="top-header__back" onClick={() => router.push("/groups")} aria-label="戻る">‹</button>
        <h1 className="top-header__title">管理</h1>
        <span className="top-header__meta">{currentUser?.display_name}</span>
      </header>

      <div className="admin-page page-content">
        <section className="admin-command-center" aria-label="管理メニュー">
          <div className="admin-command-center__header">
            <strong>管理メニュー</strong>
            <div className="admin-role-legend" aria-label="ユーザー権限の凡例">
              <span>権限</span>
              <UserRoleIcon role="executive" showLabel />
              <UserRoleIcon role="admin" showLabel />
              <UserRoleIcon role="member" showLabel />
            </div>
          </div>

          <nav className="admin-tabs" aria-label="管理機能">
            {visibleTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`admin-tab ${tab === item.id ? "admin-tab--active" : ""}`}
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <span className="admin-tab__label">
                  <item.Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </span>
                <RoleAccessIcons roles={item.roles} />
              </button>
            ))}
          </nav>
        </section>

        {tab === "users" && permissions?.canManageUsers && <UsersTab currentUser={currentUser} />}
        {tab === "groups" && permissions?.canManageGroups && <GroupsTab />}
        {tab === "attendance" && permissions?.canManageAttendance && <AttendanceAdminTab currentUser={currentUser} />}
        {tab === "leave" && permissions && <LeaveManagementHub permissions={permissions} />}
        {tab === "shifts" && permissions?.canManageAttendance && <ShiftAdminTab />}
        {tab === "pledges" && permissions?.canManageUsers && <PledgeAdminTab />}
        {tab === "payroll" && permissions?.canViewPayroll && <PayrollLaborAdminTab />}
        {tab === "hr" && permissions?.canViewPayroll && <HRAdminTab currentUser={currentUser} />}
        {tab === "manual" && permissions?.canUseManual && (
          <ManualAdminTab canManageAttendance={permissions.canManageAttendance} />
        )}
      </div>
    </>
  );
}
