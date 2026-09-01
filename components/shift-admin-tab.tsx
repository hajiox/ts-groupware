"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Building2, CheckCircle2, ChevronDown, ChevronUp, Clock3, Factory, GripVertical, LockKeyhole, MapPin, Paintbrush, Pencil, Plus, Printer, RotateCcw, Save, Trash2, Undo2, UserMinus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { USER_DEPARTMENTS, type UserDepartment } from "@/lib/departments";
import { SHIFT_COMPANY_OFF_NOTE, isCompanyOffAssignment } from "@/lib/shift-assignments";
import { resolveShiftConstraints } from "@/lib/shift-constraints";
import { shiftEcSaleDisplayLabel, type ShiftEcSaleColor, type ShiftEcSaleOption, type ShiftEcSaleTimes } from "@/lib/shift-sales";
import { buildShiftTimeeRange, parseShiftTimeeRange } from "@/lib/shift-timee";

type ShiftStatus = "draft" | "collecting" | "generated" | "editing" | "confirmed" | "exported" | "archived";

type ShiftPeriod = {
  id: string;
  department: UserDepartment;
  title: string;
  start_date: string;
  end_date: string;
  request_deadline: string | null;
  status: ShiftStatus;
  notes: string | null;
  is_test_mode: boolean;
};

type ShiftPattern = {
  id: string;
  department: UserDepartment;
  label: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  work_minutes: number | null;
  pattern_role: ShiftPatternRole;
  sort_order: number;
  is_active: boolean;
};

type ShiftPatternRole = "standard" | "basic_work" | "floor_work";

type ShiftPatternDraft = {
  label: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  pattern_role: ShiftPatternRole;
};

type ShiftEmployee = {
  id: string;
  user_id: string;
  employee_code: string | null;
  display_name: string;
  real_name: string | null;
  hire_date: string | null;
  department: UserDepartment;
  work_style: string | null;
  basic_work_start: string | null;
  basic_work_end: string | null;
  basic_break_minutes: number | null;
  request_collection_excluded: boolean;
};

type ShiftRequirement = {
  id?: string;
  period_id: string;
  work_date: string;
  required_count: number | string | null;
  workplace_label: string | null;
  notes: string | null;
  notes2: string | null;
  notes3: string | null;
  production_plan: string | null;
  timee_count: number | string | null;
  ec_sale_tags: string[];
  ec_sale_times: ShiftEcSaleTimes;
};

type ShiftRequirementUpdate = Partial<ShiftRequirement> | ((current: ShiftRequirement) => Partial<ShiftRequirement>);

type ShiftRequest = {
  id: string;
  period_id: string;
  user_id: string;
  employee_id: string | null;
  work_date: string;
  request_type: "day_off" | "unavailable" | "paid_leave_full" | "paid_leave_half" | "available" | "time_preference" | "note";
  priority: "must" | "prefer" | "ok";
  start_time: string | null;
  end_time: string | null;
  memo: string | null;
};

type ShiftRequestChange = Omit<ShiftRequest, "id" | "period_id" | "request_type"> & {
  request_type: ShiftRequest["request_type"] | "";
};

type ShiftRequestSubmission = {
  id: string;
  period_id: string;
  user_id: string;
  employee_id: string | null;
  submitted_at: string;
  request_comment: string | null;
  max_work_days: number | null;
  target_work_days: number | null;
  min_days_off: number | null;
  max_consecutive_days: number | null;
  is_test: boolean;
};

type ShiftRequestTarget = {
  id: string;
  period_id: string;
  user_id: string;
  employee_id: string | null;
  requested_at: string;
};

type ShiftAssignment = {
  id: string;
  period_id: string;
  user_id: string | null;
  employee_id: string | null;
  work_date: string;
  pattern_id: string | null;
  shift_label: string | null;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  work_minutes: number | null;
  note: string | null;
  source: "manual" | "ai" | "import";
};

type ShiftCellStyle = {
  work_date: string;
  cell_key: string;
  background_color: string | null;
};

type ShiftPayload = {
  periods: ShiftPeriod[];
  selectedPeriod: ShiftPeriod | null;
  department: UserDepartment;
  employees: ShiftEmployee[];
  excludedEmployees: ShiftEmployee[];
  patterns: ShiftPattern[];
  requirements: ShiftRequirement[];
  requests: ShiftRequest[];
  requestTargets: ShiftRequestTarget[];
  requestSubmissions: ShiftRequestSubmission[];
  assignments: ShiftAssignment[];
  saleOptions: ShiftEcSaleOption[];
  cellStyles: ShiftCellStyle[];
  summary: {
    days: number;
    staff: number;
    targets: number;
    requests: number;
    submissions: number;
    assignments: number;
    warnings: string[];
  };
};

const STATUS_LABELS: Record<ShiftStatus, string> = {
  draft: "下書き",
  collecting: "希望回収中",
  generated: "下書き作成済",
  editing: "調整中",
  confirmed: "確定",
  exported: "出力済",
  archived: "保管",
};

const REQUEST_LABELS: Record<ShiftRequest["request_type"], string> = {
  day_off: "休み",
  unavailable: "不可",
  paid_leave_full: "有給",
  paid_leave_half: "半休",
  available: "可",
  time_preference: "時間",
  note: "メモ",
};

const REGULAR_WORK_STYLES = new Set(["regular_5d_8h", "regular_6d_6_5h"]);

const DEPARTMENT_SHIFT_META: Record<UserDepartment, {
  description: string;
  tabClassName: string;
  Icon: typeof Building2;
}> = {
  フロア: {
    description: "早番・遅番を均等に割り振ります",
    tabClassName: "shift-department-tab--floor",
    Icon: Building2,
  },
  製造: {
    description: "人数が多い場合は2画面に分けて編集します",
    tabClassName: "shift-department-tab--manufacturing",
    Icon: Factory,
  },
  道の駅: {
    description: "元シフト表の個人別勤務時間傾向を反映します",
    tabClassName: "shift-department-tab--road-station",
    Icon: MapPin,
  },
};

function isRegularEmployee(employee: Pick<ShiftEmployee, "work_style">) {
  return REGULAR_WORK_STYLES.has(employee.work_style || "");
}

function isBeforeHireDate(employee: Pick<ShiftEmployee, "hire_date">, workDate: string) {
  return Boolean(employee.hire_date && workDate < employee.hire_date);
}

function isBasicShiftPattern(pattern: Pick<ShiftPattern, "label" | "pattern_role">) {
  return pattern.pattern_role === "basic_work" ||
    pattern.pattern_role === "floor_work" ||
    pattern.label === "フロア勤務" ||
    pattern.label === "基本勤務" ||
    pattern.label.startsWith("基本勤務");
}

function shiftTimingForEmployee(employee: ShiftEmployee, pattern: ShiftPattern | undefined) {
  const patternStart = pattern?.start_time?.slice(0, 5) || null;
  const patternEnd = pattern?.end_time?.slice(0, 5) || null;
  const usePersonalBasic = Boolean(
    pattern &&
    isBasicShiftPattern(pattern) &&
    employee.basic_work_start &&
    employee.basic_work_end,
  );
  const startTime = usePersonalBasic ? employee.basic_work_start!.slice(0, 5) : patternStart;
  const endTime = usePersonalBasic ? employee.basic_work_end!.slice(0, 5) : patternEnd;
  const breakMinutes = usePersonalBasic
    ? employee.basic_break_minutes ?? pattern?.break_minutes ?? 0
    : pattern?.break_minutes ?? 0;

  if (!startTime || !endTime) {
    return { startTime, endTime, breakMinutes, workMinutes: pattern?.work_minutes ?? null };
  }

  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const rawEnd = endHour * 60 + endMinute;
  const end = rawEnd < start ? rawEnd + 1440 : rawEnd;
  return {
    startTime,
    endTime,
    breakMinutes,
    workMinutes: Math.max(0, end - start - Math.max(0, breakMinutes)),
  };
}

function patternOptionsForEmployee(employee: ShiftEmployee, patterns: ShiftPattern[]) {
  if (isRegularEmployee(employee)) return patterns;
  return patterns.filter((pattern) => {
    if (isBasicShiftPattern(pattern)) return false;
    return !!pattern.start_time || !!pattern.end_time || /\d/.test(pattern.label);
  });
}

function assignmentPatternOptions(employee: ShiftEmployee, patterns: ShiftPattern[], currentLabel: string | null | undefined) {
  const options = patternOptionsForEmployee(employee, patterns);
  if (!currentLabel || options.some((pattern) => pattern.label === currentLabel)) return options;
  return [
    {
      id: `current-${employee.user_id}-${currentLabel}`,
      department: employee.department,
      label: currentLabel,
      start_time: null,
      end_time: null,
      break_minutes: 0,
      work_minutes: null,
      pattern_role: "standard" as const,
      sort_order: -1,
      is_active: true,
    },
    ...options,
  ];
}

function workStyleLabel(value: string | null) {
  if (value === "regular_5d_8h") return "5日正社員";
  if (value === "regular_6d_6_5h") return "6日正社員";
  if (value === "part_time_under_29_5h") return "パート";
  if (value === "full_time_part") return "フルタイムパート";
  if (value === "officer") return "役員";
  return "勤務形態未設定";
}

function todayText() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const jst = new Date(now.getTime() + (offset + 540) * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function monthEndDate(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function shiftHalfRange(dateText: string, half?: "first" | "second") {
  const [year, month, day] = dateText.split("-").map(Number);
  const selectedHalf = half || (day <= 15 ? "first" : "second");
  const monthText = `${year}-${String(month).padStart(2, "0")}`;
  return selectedHalf === "first"
    ? { start_date: `${monthText}-01`, end_date: `${monthText}-15`, label: "前半" }
    : { start_date: `${monthText}-16`, end_date: monthEndDate(year, month), label: "後半" };
}

function nextShiftAnchorDate(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  if (day <= 15) return `${year}-${String(month).padStart(2, "0")}-16`;
  return addDays(monthEndDate(year, month), 1);
}

function defaultShiftTitle(department: UserDepartment, startDate: string, endDate: string) {
  return `${department} ${startDate}〜${endDate}`;
}

function periodTitle(period: Pick<ShiftPeriod, "department" | "start_date" | "end_date">) {
  return defaultShiftTitle(period.department, period.start_date, period.end_date);
}

function weekday(dateText: string) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const [year, month, day] = dateText.split("-").map(Number);
  return weekdays[new Date(Date.UTC(year, month - 1, day, 15)).getUTCDay()] || "";
}

function displayName(employee: ShiftEmployee) {
  return employee.real_name || employee.display_name;
}

function formatDateShort(dateText: string) {
  return `${dateText.slice(5).replace("-", "/")} ${weekday(dateText)}`;
}

function emptyRequirement(period: ShiftPeriod, date: string): ShiftRequirement {
  return {
    period_id: period.id,
    work_date: date,
    required_count: "",
    workplace_label: period.department === "道の駅" ? "道の駅" : "本社",
    notes: "",
    notes2: "",
    notes3: "",
    production_plan: "",
    timee_count: "",
    ec_sale_tags: [],
    ec_sale_times: {},
  };
}

function manufacturingNote2Value(requirement: ShiftRequirement) {
  return [...new Set(
    [requirement.notes2, requirement.production_plan]
      .map((value) => value?.trim() || "")
      .filter(Boolean),
  )].join(" / ");
}

function confirmedNoteSignature(department: UserDepartment, requirement: ShiftRequirement) {
  if (department === "道の駅") return JSON.stringify([requirement.notes || ""]);
  if (department === "製造") {
    return JSON.stringify([
      requirement.notes || "",
      requirement.notes2 || "",
      requirement.production_plan || "",
    ]);
  }
  return JSON.stringify([requirement.notes2 || requirement.notes || ""]);
}

function RoadStationTimeeEditor({
  requirement,
  disabled,
  onChange,
}: {
  requirement: ShiftRequirement;
  disabled: boolean;
  onChange: (value: ShiftRequirementUpdate) => void;
}) {
  const range = parseShiftTimeeRange(requirement.notes3);
  const textValue = requirement.notes2 || (requirement.timee_count === null || requirement.timee_count === "" ? "" : String(requirement.timee_count));
  return (
    <div className="shift-timee-editor">
      <input
        type="text"
        value={textValue}
        onChange={(event) => onChange({ notes2: event.target.value, timee_count: "" })}
        disabled={disabled}
        placeholder="氏名・人数・内容"
        aria-label="Timeeの内容"
      />
      <div className="shift-timee-editor__times">
        <label>
          <span>開始</span>
          <input
            type="time"
            value={range.startTime}
            onChange={(event) => {
              const startTime = event.target.value;
              onChange((current) => {
                const currentRange = parseShiftTimeeRange(current.notes3);
                return { notes3: buildShiftTimeeRange(startTime, currentRange.endTime) };
              });
            }}
            disabled={disabled}
            aria-label="Timeeの開始時刻"
          />
        </label>
        <span aria-hidden="true">〜</span>
        <label>
          <span>終了</span>
          <input
            type="time"
            value={range.endTime}
            onChange={(event) => {
              const endTime = event.target.value;
              onChange((current) => {
                const currentRange = parseShiftTimeeRange(current.notes3);
                return { notes3: buildShiftTimeeRange(currentRange.startTime, endTime) };
              });
            }}
            disabled={disabled}
            aria-label="Timeeの終了時刻"
          />
        </label>
      </div>
    </div>
  );
}

function ShiftEcSalePicker({
  options,
  selected,
  times,
  disabled,
  onChange,
  onManage,
}: {
  options: ShiftEcSaleOption[];
  selected: string[];
  times: ShiftEcSaleTimes;
  disabled: boolean;
  onChange: (next: string[], nextTimes: ShiftEcSaleTimes) => void;
  onManage: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<string[]>(selected || []);
  const [draftTimes, setDraftTimes] = useState<ShiftEcSaleTimes>(times || {});
  const selectedSet = new Set(selected || []);
  const draftSet = new Set(draft);
  const selectedOptions = options.filter((option) => selectedSet.has(option.id));
  const activeOptions = options.filter((option) => option.is_active || selectedSet.has(option.id));

  useEffect(() => {
    setDraft(selected || []);
    setDraftTimes(times || {});
  }, [selected, times]);

  function closePicker() {
    detailsRef.current?.removeAttribute("open");
  }

  function updateDraftTime(saleId: string, field: "start_time" | "end_time", value: string) {
    setDraftTimes((current) => ({
      ...current,
      [saleId]: {
        start_time: field === "start_time" ? value || null : current[saleId]?.start_time || null,
        end_time: field === "end_time" ? value || null : current[saleId]?.end_time || null,
      },
    }));
  }

  function collectEnteredTimes() {
    const selectedIds = new Set(draft);
    const enteredTimes: ShiftEcSaleTimes = {};
    detailsRef.current?.querySelectorAll<HTMLInputElement>("input[data-ec-sale-id][data-ec-sale-time]").forEach((input) => {
      const saleId = input.dataset.ecSaleId || "";
      const field = input.dataset.ecSaleTime;
      if (!selectedIds.has(saleId) || (field !== "start_time" && field !== "end_time")) return;
      const current = enteredTimes[saleId] || { start_time: null, end_time: null };
      current[field] = input.value || null;
      enteredTimes[saleId] = current;
    });
    return Object.fromEntries(
      Object.entries(enteredTimes).filter(([, value]) => value.start_time || value.end_time),
    ) as ShiftEcSaleTimes;
  }

  return (
    <div className="shift-ec-sales">
      <details ref={detailsRef} className="shift-ec-sales__picker">
        <summary>
          <span>ECセール</span>
          <strong>{selectedOptions.length}件</strong>
        </summary>
        <div className="shift-ec-sales__menu">
          <button
            type="button"
            className="shift-ec-sales__manage"
            onClick={() => {
              closePicker();
              onManage();
            }}
          >
            <Pencil size={14} aria-hidden="true" />
            ECセール名を編集
          </button>
          {activeOptions.map((option) => {
            const checked = draftSet.has(option.id);
            const occurrenceTime = draftTimes[option.id] || { start_time: null, end_time: null };
            return (
              <div key={option.id} className={`shift-ec-sale-option-wrap shift-ec-sale-option-wrap--${option.color}${checked ? " shift-ec-sale-option-wrap--selected" : ""}`}>
                <label className={`shift-ec-sale-option shift-ec-sale-option--${option.color}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draftSet, option.id]
                        : [...draftSet].filter((id) => id !== option.id);
                      setDraft(next);
                      if (!event.target.checked) {
                        setDraftTimes((current) => {
                          const nextTimes = { ...current };
                          delete nextTimes[option.id];
                          return nextTimes;
                        });
                      }
                    }}
                  />
                  <span>{option.label}{option.is_active ? "" : "（削除済み）"}</span>
                </label>
                {checked && (
                  <div className="shift-ec-sale-option__times">
                    <label>
                      <span>開始</span>
                      <input
                        type="time"
                        value={occurrenceTime.start_time || ""}
                        disabled={disabled}
                        data-ec-sale-id={option.id}
                        data-ec-sale-time="start_time"
                        onInput={(event) => updateDraftTime(option.id, "start_time", event.currentTarget.value)}
                        onChange={(event) => updateDraftTime(option.id, "start_time", event.currentTarget.value)}
                        aria-label={`${option.label}の開始時刻`}
                      />
                    </label>
                    <label>
                      <span>終了</span>
                      <input
                        type="time"
                        value={occurrenceTime.end_time || ""}
                        disabled={disabled}
                        data-ec-sale-id={option.id}
                        data-ec-sale-time="end_time"
                        onInput={(event) => updateDraftTime(option.id, "end_time", event.currentTarget.value)}
                        onChange={(event) => updateDraftTime(option.id, "end_time", event.currentTarget.value)}
                        aria-label={`${option.label}の終了時刻`}
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          <div className="shift-ec-sales__menu-actions">
            <button
              type="button"
              className="admin-btn-outline"
              onClick={() => {
                setDraft(selected || []);
                setDraftTimes(times || {});
                closePicker();
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={disabled}
              onClick={() => {
                const selectedTimes = collectEnteredTimes();
                setDraftTimes(selectedTimes);
                onChange(draft, selectedTimes);
                closePicker();
              }}
            >
              備考に追加
            </button>
          </div>
        </div>
      </details>
      {selectedOptions.length > 0 && (
        <div className="shift-ec-sales__selected">
          {selectedOptions.map((option) => {
            const occurrenceTime = times?.[option.id] || { start_time: null, end_time: null };
            return (
              <span key={option.id} className={`shift-ec-sale-chip shift-ec-sale-chip--${option.color}`}>
                {shiftEcSaleDisplayLabel({ label: option.label, ...occurrenceTime })}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

const CELL_COLOR_OPTIONS = [
  { color: "#75e6e5", label: "勤務時間希望" },
  { color: "#ffe699", label: "物販対応" },
  { color: "#f4b7b2", label: "レクチャー" },
  { color: "#f4b183", label: "猪苗代納品日" },
  { color: "#8ea9db", label: "伝票出し" },
  { color: "#c6e0b4", label: "シフト調整してくれた方" },
  { color: "#111827", label: "会社付与休日" },
  { color: "#fff2cc", label: "火・土 物販対応設定日" },
] as const;

const DATE_COLOR_OPTIONS = [
  { color: "#ef4444", label: "赤" },
  { color: "#f97316", label: "オレンジ" },
  { color: "#eab308", label: "黄" },
  { color: "#22c55e", label: "緑" },
  { color: "#06b6d4", label: "水色" },
  { color: "#3b82f6", label: "青" },
  { color: "#8b5cf6", label: "紫" },
  { color: "#64748b", label: "グレー" },
] as const;

function isDarkCellColor(color: string | null | undefined) {
  const hex = color?.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 < 145;
}

function ShiftDateColorPicker({
  currentColor,
  disabled,
  label,
  onChange,
}: {
  currentColor?: string | null;
  disabled: boolean;
  label: string;
  onChange: (color: string) => void;
}) {
  function chooseColor(element: HTMLElement, color: string) {
    onChange(color);
    const details = element.closest("details");
    if (details) details.open = false;
  }

  return (
    <details
      className="shift-date-color-picker"
      name="shift-date-color-picker"
      style={{ "--shift-picker-color": currentColor || "transparent" } as CSSProperties}
    >
      <summary
        title={`${label}の色を変更`}
        aria-label={`${label}の色を変更`}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <Paintbrush size={13} aria-hidden="true" />
      </summary>
      <div className="shift-date-color-picker__menu" role="group" aria-label={`${label}のカラーパレット`}>
        {DATE_COLOR_OPTIONS.map((option) => (
          <button
            key={option.color}
            type="button"
            className={currentColor === option.color ? "shift-date-color-picker__swatch shift-date-color-picker__swatch--active" : "shift-date-color-picker__swatch"}
            style={{ backgroundColor: option.color }}
            onClick={(event) => chooseColor(event.currentTarget, option.color)}
            disabled={disabled}
            title={option.label}
            aria-label={`${label}を${option.label}にする`}
          />
        ))}
        <button
          type="button"
          className="shift-date-color-picker__clear"
          onClick={(event) => chooseColor(event.currentTarget, "")}
          disabled={disabled || !currentColor}
        >
          <RotateCcw size={13} aria-hidden="true" />
          色なし
        </button>
      </div>
    </details>
  );
}

function ShiftCellColorPicker({
  currentColor,
  disabled,
  label,
  onChange,
}: {
  currentColor?: string | null;
  disabled: boolean;
  label: string;
  onChange: (color: string) => void;
}) {
  function closePalette(element: HTMLElement) {
    const details = element.closest("details");
    if (details) details.open = false;
  }

  return (
    <details className="shift-cell-color-picker" style={{ "--shift-picker-color": currentColor || "transparent" } as CSSProperties}>
      <summary
        title={`${label}の色を変更`}
        aria-label={`${label}の色を変更`}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <Paintbrush size={13} aria-hidden="true" />
      </summary>
      <div className="shift-cell-color-picker__menu" role="group" aria-label={`${label}のカラーパレット`}>
        {CELL_COLOR_OPTIONS.map((option) => (
          <button
            key={option.color}
            type="button"
            className={currentColor === option.color ? "shift-cell-color-picker__option shift-cell-color-picker__option--active" : "shift-cell-color-picker__option"}
            onClick={(event) => {
              onChange(option.color);
              closePalette(event.currentTarget);
            }}
            disabled={disabled}
            title={option.label}
          >
            <span style={{ backgroundColor: option.color }} aria-hidden="true" />
            {option.label}
          </button>
        ))}
        <div className="shift-cell-color-picker__other">
          <span className="shift-cell-color-picker__other-label">その他の色</span>
          <div className="shift-cell-color-picker__swatches">
            {DATE_COLOR_OPTIONS.map((option) => (
              <button
                key={option.color}
                type="button"
                className={currentColor === option.color ? "shift-cell-color-picker__swatch shift-cell-color-picker__swatch--active" : "shift-cell-color-picker__swatch"}
                style={{ backgroundColor: option.color }}
                onClick={(event) => {
                  onChange(option.color);
                  closePalette(event.currentTarget);
                }}
                disabled={disabled}
                title={option.label}
                aria-label={`${label}を${option.label}にする`}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          className="shift-cell-color-picker__clear"
          onClick={(event) => {
            onChange("");
            closePalette(event.currentTarget);
          }}
          disabled={disabled || !currentColor}
        >
          <RotateCcw size={13} aria-hidden="true" />
          色なし
        </button>
      </div>
    </details>
  );
}

function ShiftEcSaleManager({
  open,
  onOpenChange,
  options,
  disabled,
  disabledReason,
  onCreate,
  onUpdate,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: ShiftEcSaleOption[];
  disabled: boolean;
  disabledReason: string;
  onCreate: (label: string, color: ShiftEcSaleColor) => Promise<void>;
  onUpdate: (sale: ShiftEcSaleOption, label: string, color: ShiftEcSaleColor) => Promise<void>;
  onToggle: (sale: ShiftEcSaleOption) => Promise<void>;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState<ShiftEcSaleColor>("red");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="shift-sale-manager" showCloseButton={false}>
        <DialogHeader className="shift-sale-manager__header">
          <div>
            <span>備考候補</span>
            <DialogTitle>ECセール名を編集</DialogTitle>
            <DialogDescription className="sr-only">シフト備考で使用するECセール名を追加、変更、削除します。</DialogDescription>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} aria-label="閉じる" title="閉じる">
            <X size={19} aria-hidden="true" />
          </button>
        </DialogHeader>
        <div className="shift-sale-manager__body">
          {disabledReason && <div className="shift-sale-manager__notice" role="status">{disabledReason}</div>}
          <div className="shift-sale-manager__new">
            <input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="新しいECセール名"
              aria-label="新しいECセール名"
              maxLength={100}
            />
            <select value={newColor} onChange={(event) => setNewColor(event.target.value as ShiftEcSaleColor)} aria-label="新しいECセールの表示色">
              <option value="red">赤</option>
              <option value="green">緑</option>
              <option value="orange">オレンジ</option>
            </select>
            <button
              type="button"
              className="btn-primary"
              disabled={disabled || !newLabel.trim()}
              onClick={async () => {
                await onCreate(newLabel.trim(), newColor);
                setNewLabel("");
              }}
            >
              <Plus size={16} aria-hidden="true" />
              追加
            </button>
          </div>
          <div className="shift-sale-manager__list" aria-label="登録済みECセール名">
            {options.map((sale) => (
              <ShiftEcSaleEditor key={`${sale.id}:${sale.label}:${sale.color}:${sale.is_active}`} sale={sale} disabled={disabled} onUpdate={onUpdate} onToggle={onToggle} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShiftEcSaleEditor({
  sale,
  disabled,
  onUpdate,
  onToggle,
}: {
  sale: ShiftEcSaleOption;
  disabled: boolean;
  onUpdate: (sale: ShiftEcSaleOption, label: string, color: ShiftEcSaleColor) => Promise<void>;
  onToggle: (sale: ShiftEcSaleOption) => Promise<void>;
}) {
  const [label, setLabel] = useState(sale.label);
  const [color, setColor] = useState<ShiftEcSaleColor>(sale.color);
  const hasChanges = label.trim() !== sale.label || color !== sale.color;
  return (
    <div className={`shift-sale-manager__row${sale.is_active ? "" : " shift-sale-manager__row--inactive"}`}>
      <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} disabled={!sale.is_active} aria-label={`${sale.label}の名称`} />
      <select value={color} onChange={(event) => setColor(event.target.value as ShiftEcSaleColor)} disabled={!sale.is_active} aria-label={`${sale.label}の表示色`}>
        <option value="red">赤</option>
        <option value="green">緑</option>
        <option value="orange">オレンジ</option>
      </select>
      <div className="shift-sale-manager__actions">
        {sale.is_active && (
          <button type="button" className="admin-btn-outline" disabled={disabled || !label.trim() || !hasChanges} onClick={() => onUpdate(sale, label.trim(), color)}>
            <Save size={14} aria-hidden="true" />
            保存
          </button>
        )}
        <button type="button" className={sale.is_active ? "admin-btn-danger" : "admin-btn-outline"} disabled={disabled} onClick={() => onToggle(sale)}>
          {sale.is_active ? <Trash2 size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          {sale.is_active ? "削除" : "再表示"}
        </button>
      </div>
    </div>
  );
}

const SHIFT_PATTERN_ROLE_LABELS: Record<ShiftPatternRole, string> = {
  standard: "通常の時間帯",
  basic_work: "正社員の基本勤務",
  floor_work: "不足時のフロア勤務",
};

function emptyShiftPatternDraft(): ShiftPatternDraft {
  return {
    label: "",
    start_time: "",
    end_time: "",
    break_minutes: 0,
    pattern_role: "standard",
  };
}

function shiftPatternDraft(pattern: ShiftPattern): ShiftPatternDraft {
  return {
    label: pattern.label,
    start_time: pattern.start_time?.slice(0, 5) || "",
    end_time: pattern.end_time?.slice(0, 5) || "",
    break_minutes: pattern.break_minutes || 0,
    pattern_role: pattern.pattern_role || "standard",
  };
}

function ShiftPatternFields({
  department,
  draft,
  disabled,
  onChange,
}: {
  department: UserDepartment;
  draft: ShiftPatternDraft;
  disabled: boolean;
  onChange: (next: ShiftPatternDraft) => void;
}) {
  return (
    <div className="shift-pattern-fields">
      <label className="shift-pattern-fields__label">
        <span>表示名</span>
        <input
          value={draft.label}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          maxLength={100}
          disabled={disabled}
          placeholder="例: 8:30-16:00"
        />
      </label>
      <label>
        <span>用途</span>
        <select
          value={draft.pattern_role}
          onChange={(event) => onChange({ ...draft, pattern_role: event.target.value as ShiftPatternRole })}
          disabled={disabled}
        >
          <option value="standard">{SHIFT_PATTERN_ROLE_LABELS.standard}</option>
          <option value="basic_work">{SHIFT_PATTERN_ROLE_LABELS.basic_work}</option>
          {department === "フロア" && <option value="floor_work">{SHIFT_PATTERN_ROLE_LABELS.floor_work}</option>}
        </select>
      </label>
      <label>
        <span>出勤</span>
        <input
          type="time"
          value={draft.start_time}
          onChange={(event) => onChange({ ...draft, start_time: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label>
        <span>退勤</span>
        <input
          type="time"
          value={draft.end_time}
          onChange={(event) => onChange({ ...draft, end_time: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label>
        <span>休憩</span>
        <span className="shift-pattern-fields__minutes">
          <input
            type="number"
            min="0"
            max="480"
            step="15"
            inputMode="numeric"
            value={draft.break_minutes}
            onChange={(event) => onChange({ ...draft, break_minutes: Number(event.target.value) || 0 })}
            disabled={disabled}
          />
          <small>分</small>
        </span>
      </label>
    </div>
  );
}

function ShiftPatternEditor({
  department,
  pattern,
  disabled,
  canMoveUp,
  canMoveDown,
  onUpdate,
  onDelete,
  onMove,
}: {
  department: UserDepartment;
  pattern: ShiftPattern;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUpdate: (pattern: ShiftPattern, draft: ShiftPatternDraft) => Promise<void>;
  onDelete: (pattern: ShiftPattern) => Promise<void>;
  onMove: (pattern: ShiftPattern, direction: -1 | 1) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => shiftPatternDraft(pattern));
  const original = shiftPatternDraft(pattern);
  const changed = JSON.stringify(draft) !== JSON.stringify(original);

  return (
    <div className="shift-pattern-manager__row">
      <div className="shift-pattern-manager__order" aria-label={`${pattern.label}の並び順`}>
        <button type="button" onClick={() => onMove(pattern, -1)} disabled={disabled || !canMoveUp} title="上へ移動" aria-label={`${pattern.label}を上へ移動`}>
          <ChevronUp size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onMove(pattern, 1)} disabled={disabled || !canMoveDown} title="下へ移動" aria-label={`${pattern.label}を下へ移動`}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      <ShiftPatternFields department={department} draft={draft} disabled={disabled} onChange={setDraft} />
      <div className="shift-pattern-manager__actions">
        <button
          type="button"
          className="admin-btn-outline"
          disabled={disabled || !changed || !draft.label.trim()}
          onClick={() => onUpdate(pattern, { ...draft, label: draft.label.trim() })}
        >
          <Save size={15} aria-hidden="true" />
          保存
        </button>
        <button
          type="button"
          className="admin-btn-danger"
          disabled={disabled}
          onClick={() => onDelete(pattern)}
          title="今後の選択候補から削除"
        >
          <Trash2 size={15} aria-hidden="true" />
          削除
        </button>
      </div>
    </div>
  );
}

function ShiftPatternManager({
  department,
  patterns,
  disabled,
  saving,
  onCreate,
  onUpdate,
  onDelete,
  onMove,
}: {
  department: UserDepartment;
  patterns: ShiftPattern[];
  disabled: boolean;
  saving: boolean;
  onCreate: (draft: ShiftPatternDraft) => Promise<void>;
  onUpdate: (pattern: ShiftPattern, draft: ShiftPatternDraft) => Promise<void>;
  onDelete: (pattern: ShiftPattern) => Promise<void>;
  onMove: (pattern: ShiftPattern, direction: -1 | 1) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ShiftPatternDraft>(emptyShiftPatternDraft);

  useEffect(() => {
    setDraft(emptyShiftPatternDraft());
  }, [department]);

  return (
    <details className="shift-pattern-manager">
      <summary>
        <span className="shift-pattern-manager__summary-heading">
          <strong>{department}の勤務候補を編集</strong>
          <small>名称・時刻・休憩・表示順を所属別に管理</small>
        </span>
        <span className="shift-pattern-manager__summary-action">
          <em>{patterns.length}件</em>
          <ChevronDown size={18} aria-hidden="true" />
        </span>
      </summary>
      <div className="shift-pattern-manager__body">
        <div
          className={`shift-pattern-manager__notice${saving ? " shift-pattern-manager__notice--saving" : ""}`}
          role="status"
          aria-live="polite"
        >
          {saving
            ? "勤務候補を保存しています..."
            : "変更後の候補は新しい選択とAI下書きに使われます。すでに保存済みのシフト表示は変わりません。"}
        </div>
        <div className="shift-pattern-manager__new">
          <div className="shift-pattern-manager__new-heading">
            <Plus size={17} aria-hidden="true" />
            <strong>勤務候補を追加</strong>
          </div>
          <ShiftPatternFields department={department} draft={draft} disabled={disabled} onChange={setDraft} />
          <button
            type="button"
            className="btn-primary shift-pattern-manager__add"
            disabled={disabled || !draft.label.trim()}
            onClick={async () => {
              await onCreate({ ...draft, label: draft.label.trim() });
              setDraft(emptyShiftPatternDraft());
            }}
          >
            <Plus size={16} aria-hidden="true" />
            追加
          </button>
        </div>
        <div className="shift-pattern-manager__list">
          {patterns.map((pattern, index) => (
            <ShiftPatternEditor
              key={`${pattern.id}:${pattern.label}:${pattern.start_time}:${pattern.end_time}:${pattern.break_minutes}:${pattern.pattern_role}`}
              department={department}
              pattern={pattern}
              disabled={disabled}
              canMoveUp={index > 0}
              canMoveDown={index < patterns.length - 1}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onMove={onMove}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function splitEmployeesForTable(department: UserDepartment | undefined, employees: ShiftEmployee[]) {
  if (department === "製造" && employees.length > 7) {
    const pageSize = Math.ceil(employees.length / 2);
    return [
      employees.slice(0, pageSize),
      employees.slice(pageSize),
    ].filter((page) => page.length > 0);
  }
  return [employees];
}

function cloneShiftPayload(payload: ShiftPayload) {
  return JSON.parse(JSON.stringify(payload)) as ShiftPayload;
}

function applyShiftPatternMutation(
  patterns: ShiftPattern[],
  body: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "create_pattern") {
    const pattern = result.pattern as ShiftPattern | undefined;
    return pattern ? [...patterns, pattern].sort((a, b) => a.sort_order - b.sort_order) : patterns;
  }
  if (action === "update_pattern") {
    const pattern = result.pattern as ShiftPattern | undefined;
    return pattern ? patterns.map((current) => current.id === pattern.id ? pattern : current) : patterns;
  }
  if (action === "delete_pattern") {
    const patternId = typeof result.pattern_id === "string"
      ? result.pattern_id
      : typeof body.pattern_id === "string" ? body.pattern_id : "";
    return patternId ? patterns.filter((pattern) => pattern.id !== patternId) : patterns;
  }
  if (action === "reorder_patterns") {
    const patternIds = Array.isArray(result.pattern_ids)
      ? result.pattern_ids.filter((id): id is string => typeof id === "string")
      : Array.isArray(body.pattern_ids)
        ? body.pattern_ids.filter((id): id is string => typeof id === "string")
        : [];
    const order = new Map(patternIds.map((id, index) => [id, index]));
    return [...patterns]
      .sort((a, b) => (order.get(a.id) ?? patterns.length) - (order.get(b.id) ?? patterns.length))
      .map((pattern, index) => ({ ...pattern, sort_order: (index + 1) * 10 }));
  }
  return patterns;
}

function applyShiftSaleMutation(
  options: ShiftEcSaleOption[],
  body: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "create_sale") {
    const sale = result.sale as ShiftEcSaleOption | undefined;
    return sale ? [...options, sale].sort((a, b) => a.sort_order - b.sort_order) : options;
  }

  const saleId = typeof body.sale_id === "string" ? body.sale_id : "";
  if (!saleId) return options;
  if (action === "update_sale") {
    const label = typeof body.label === "string" ? body.label : "";
    const color = body.color === "red" || body.color === "green" || body.color === "orange" ? body.color : null;
    return options.map((sale) => sale.id === saleId
      ? { ...sale, label: label || sale.label, color: color || sale.color, start_time: null, end_time: null }
      : sale);
  }
  if (action === "delete_sale" || action === "restore_sale") {
    return options.map((sale) => sale.id === saleId ? { ...sale, is_active: action === "restore_sale" } : sale);
  }
  return options;
}

function shiftRequestKey(request: Pick<ShiftRequest, "user_id" | "work_date">) {
  return `${request.user_id}:${request.work_date}`;
}

function comparableShiftRequest(request: ShiftRequest | undefined) {
  if (!request) return null;
  return {
    user_id: request.user_id,
    employee_id: request.employee_id,
    work_date: request.work_date,
    request_type: request.request_type,
    priority: request.priority,
    start_time: request.start_time,
    end_time: request.end_time,
    memo: request.memo,
  };
}

function changedShiftRequests(current: ShiftRequest[], saved: ShiftRequest[]): ShiftRequestChange[] {
  const currentMap = new Map(current.map((request) => [shiftRequestKey(request), request]));
  const savedMap = new Map(saved.map((request) => [shiftRequestKey(request), request]));
  const keys = new Set([...currentMap.keys(), ...savedMap.keys()]);
  const changes: ShiftRequestChange[] = [];
  for (const key of keys) {
    const currentRequest = currentMap.get(key);
    const savedRequest = savedMap.get(key);
    if (JSON.stringify(comparableShiftRequest(currentRequest)) === JSON.stringify(comparableShiftRequest(savedRequest))) continue;
    if (currentRequest) {
      changes.push(comparableShiftRequest(currentRequest)!);
      continue;
    }
    changes.push({
      user_id: savedRequest!.user_id,
      employee_id: savedRequest!.employee_id,
      work_date: savedRequest!.work_date,
      request_type: "",
      priority: "must",
      start_time: null,
      end_time: null,
      memo: null,
    });
  }
  return changes;
}

export function ShiftAdminTab() {
  const initialDate = nextShiftAnchorDate(todayText());
  const initialRange = shiftHalfRange(initialDate);
  const [department, setDepartment] = useState<UserDepartment>("フロア");
  const [periodId, setPeriodId] = useState("");
  const [payload, setPayload] = useState<ShiftPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [draggedEmployeeId, setDraggedEmployeeId] = useState("");
  const [dragOverEmployeeId, setDragOverEmployeeId] = useState("");
  const [showAllPeriods, setShowAllPeriods] = useState(false);
  const [saleManagerOpen, setSaleManagerOpen] = useState(false);
  const [shiftEmployeePage, setShiftEmployeePage] = useState(0);
  const [openTimeEditorKeys, setOpenTimeEditorKeys] = useState<Set<string>>(new Set());
  const [collectionTargetIds, setCollectionTargetIds] = useState<Set<string>>(new Set());
  const [periodDeadlineDraft, setPeriodDeadlineDraft] = useState("");
  const loadSeqRef = useRef(0);
  const savedPayloadRef = useRef<ShiftPayload | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [confirmedNotesEditing, setConfirmedNotesEditing] = useState(false);
  const [form, setForm] = useState({
    start_date: initialRange.start_date,
    end_date: initialRange.end_date,
    request_deadline: addDays(initialRange.start_date, -3),
    notes: "",
  });

  const selectedPeriod = payload?.selectedPeriod || null;
  const isShiftLocked = Boolean(selectedPeriod && ["confirmed", "exported", "archived"].includes(selectedPeriod.status));
  const canEditConfirmedNotes = selectedPeriod?.status === "confirmed";
  const isConfirmedNotesEditing = canEditConfirmedNotes && confirmedNotesEditing;
  const shiftControlsDisabled = Boolean(savingKey) || isShiftLocked;
  const confirmedNotesDisabled = Boolean(savingKey) || (isShiftLocked && !isConfirmedNotesEditing);
  const allPeriods = payload?.periods || [];
  const visiblePeriods = showAllPeriods ? allPeriods : allPeriods.slice(0, 5);
  const newPeriodTitle = defaultShiftTitle(department, form.start_date, form.end_date);
  const collectionEmployees = useMemo(
    () => (payload?.employees || []).filter((employee) => !employee.request_collection_excluded),
    [payload?.employees],
  );
  const employeePages = useMemo(
    () => splitEmployeesForTable(selectedPeriod?.department, payload?.employees || []),
    [payload?.employees, selectedPeriod?.department],
  );
  const visibleShiftEmployees = employeePages[Math.min(shiftEmployeePage, Math.max(0, employeePages.length - 1))] || [];
  const isCompactShiftTable = visibleShiftEmployees.length <= 8 || employeePages.length > 1;
  const patternByLabel = useMemo(() => {
    const map = new Map<string, ShiftPattern>();
    for (const pattern of payload?.patterns || []) map.set(pattern.label, pattern);
    return map;
  }, [payload?.patterns]);
  const assignmentMap = useMemo(() => {
    const map = new Map<string, ShiftAssignment>();
    for (const assignment of payload?.assignments || []) {
      if (assignment.user_id) map.set(`${assignment.user_id}:${assignment.work_date}`, assignment);
    }
    return map;
  }, [payload?.assignments]);
  const requestMap = useMemo(() => {
    const map = new Map<string, ShiftRequest>();
    for (const request of payload?.requests || []) map.set(`${request.user_id}:${request.work_date}`, request);
    return map;
  }, [payload?.requests]);
  const submittedUserIds = useMemo(() => {
    return new Set((payload?.requestSubmissions || []).map((submission) => submission.user_id));
  }, [payload?.requestSubmissions]);
  const submissionByUserId = useMemo(() => {
    return new Map((payload?.requestSubmissions || []).map((submission) => [submission.user_id, submission]));
  }, [payload?.requestSubmissions]);
  const targetUserIds = useMemo(() => {
    return new Set((payload?.requestTargets || []).map((target) => target.user_id));
  }, [payload?.requestTargets]);
  const effectiveTargetUserIds = useMemo(() => {
    if (targetUserIds.size > 0) return targetUserIds;
    if (selectedPeriod?.status === "collecting") return new Set(collectionEmployees.map((employee) => employee.user_id));
    return new Set<string>();
  }, [collectionEmployees, selectedPeriod?.status, targetUserIds]);
  const requestCountByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const request of payload?.requests || []) {
      map.set(request.user_id, (map.get(request.user_id) || 0) + 1);
    }
    return map;
  }, [payload?.requests]);
  const requirementMap = useMemo(() => {
    const map = new Map<string, ShiftRequirement>();
    for (const requirement of payload?.requirements || []) map.set(requirement.work_date, requirement);
    return map;
  }, [payload?.requirements]);
  const cellStyleMap = useMemo(() => new Map(
    (payload?.cellStyles || []).map((style) => [`${style.work_date}:${style.cell_key}`, style.background_color]),
  ), [payload?.cellStyles]);
  const registeredShiftTimes = useMemo(() => {
    const labels = new Set<string>();
    for (const pattern of payload?.patterns || []) {
      const startTime = pattern.start_time?.slice(0, 5) || null;
      const endTime = pattern.end_time?.slice(0, 5) || null;
      if (startTime && endTime) labels.add(`${startTime}-${endTime}`);
      else if (startTime) labels.add(`${startTime}以降`);
      else if (endTime) labels.add(`${endTime}まで`);
    }
    return [...labels];
  }, [payload?.patterns]);

  async function load(nextPeriodId = periodId, nextDepartment = department) {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setIsLoading(true);
    setMessage("");
    const params = new URLSearchParams();
    params.set("department", nextDepartment);
    if (nextPeriodId) params.set("period_id", nextPeriodId);
    const response = await fetch(`/api/admin/shifts?${params.toString()}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (loadSeq !== loadSeqRef.current) return false;
      setMessage(data?.error || "シフト情報を読み込めませんでした");
      setIsLoading(false);
      return false;
    }
    if (loadSeq !== loadSeqRef.current) return false;
    setPayload(data);
    savedPayloadRef.current = cloneShiftPayload(data);
    setOpenTimeEditorKeys(new Set());
    setHasUnsavedChanges(false);
    setConfirmedNotesEditing(false);
    setDepartment(data.department || nextDepartment);
    setPeriodId(data.selectedPeriod?.id || "");
    setIsLoading(false);
    return true;
  }

  async function switchDepartment(nextDepartment: UserDepartment) {
    if (nextDepartment === department || isLoading) return;
    if (hasUnsavedChanges && !window.confirm("一時保存していない変更を破棄して、所属を切り替えますか？")) return;
    setHasUnsavedChanges(false);
    setDepartment(nextDepartment);
    setPeriodId("");
    setShowAllPeriods(false);
    setShiftEmployeePage(0);
    try {
      await load("", nextDepartment);
    } catch {
      setMessage("シフト情報を読み込めませんでした");
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load("", department).catch(() => {
      setMessage("シフト情報を読み込めませんでした");
      setIsLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setShiftEmployeePage(0);
  }, [selectedPeriod?.id, selectedPeriod?.department, payload?.employees.length]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!selectedPeriod) return;
    const existingTargets = payload?.requestTargets || [];
    setCollectionTargetIds(new Set(
      existingTargets.length > 0
        ? existingTargets.map((target) => target.user_id)
        : collectionEmployees.map((employee) => employee.user_id),
    ));
  }, [selectedPeriod, payload?.requestTargets, collectionEmployees]);

  useEffect(() => {
    setPeriodDeadlineDraft(selectedPeriod?.request_deadline || "");
  }, [selectedPeriod?.id, selectedPeriod?.request_deadline]);

  async function createPeriod() {
    if (hasUnsavedChanges) {
      setMessage("現在のシフトを一時保存するか、変更をキャンセルしてから新しい期間を作成してください");
      return;
    }
    const createDepartment = department;
    const title = defaultShiftTitle(createDepartment, form.start_date, form.end_date);
    setSavingKey("create");
    setMessage("");
    try {
      const response = await fetch("/api/admin/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, department: createDepartment, title }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(data?.error || "シフト期間を作成できませんでした");
        return;
      }
      setMessage(data.calendar_warning
        ? `シフト期間を作成しました。${data.calendar_warning}`
        : "シフト期間を作成しました。希望回収を押すとスタッフのシフト画面に表示されます");
      await load(data.period.id, data.period.department || createDepartment);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "シフト期間を作成できませんでした");
    } finally {
      setSavingKey("");
    }
  }

  function applyHalf(half: "first" | "second") {
    const baseDate = form.start_date || todayText();
    const range = shiftHalfRange(baseDate, half);
    setForm({
      ...form,
      start_date: range.start_date,
      end_date: range.end_date,
      request_deadline: addDays(range.start_date, -3),
    });
  }

  async function patchPeriod(targetPeriodId: string, body: Record<string, unknown>, successMessage?: string) {
    const response = await fetch("/api/admin/shifts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period_id: targetPeriodId, ...body }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "保存に失敗しました");
    if (successMessage) setMessage(successMessage);
    return data;
  }

  async function patch(body: Record<string, unknown>, successMessage?: string) {
    if (!selectedPeriod) return;
    return patchPeriod(selectedPeriod.id, body, successMessage);
  }

  function handleEmployeeDragStart(event: DragEvent<HTMLElement>, userId: string) {
    if (shiftControlsDisabled) {
      event.preventDefault();
      return;
    }
    setDraggedEmployeeId(userId);
    setDragOverEmployeeId("");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", userId);
  }

  function handleEmployeeDragEnd() {
    setDraggedEmployeeId("");
    setDragOverEmployeeId("");
  }

  async function handleEmployeeDrop(event: DragEvent<HTMLElement>, targetUserId: string) {
    event.preventDefault();
    const sourceUserId = draggedEmployeeId || event.dataTransfer.getData("text/plain");
    setDraggedEmployeeId("");
    setDragOverEmployeeId("");
    if (!payload || !selectedPeriod || shiftControlsDisabled || !sourceUserId || sourceUserId === targetUserId) return;

    const previousEmployees = payload.employees;
    const sourceIndex = previousEmployees.findIndex((employee) => employee.user_id === sourceUserId);
    const targetIndex = previousEmployees.findIndex((employee) => employee.user_id === targetUserId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const nextEmployees = [...previousEmployees];
    const [movedEmployee] = nextEmployees.splice(sourceIndex, 1);
    nextEmployees.splice(targetIndex, 0, movedEmployee);
    setPayload((current) => current ? { ...current, employees: nextEmployees } : current);
    setSavingKey("employee-order");
    setMessage("");
    try {
      const result = await patch({
        action: "reorder_employees",
        user_ids: nextEmployees.map((employee) => employee.user_id),
      });
      if (Number(result?.employees) !== nextEmployees.length) {
        throw new Error("スタッフ順の保存件数を確認できませんでした");
      }
      if (savedPayloadRef.current) {
        savedPayloadRef.current = { ...savedPayloadRef.current, employees: nextEmployees };
      }
      setMessage("スタッフの並び順を保存しました");
    } catch (err) {
      setPayload((current) => current ? { ...current, employees: previousEmployees } : current);
      setMessage(err instanceof Error ? err.message : "スタッフの並び順を保存できませんでした");
    } finally {
      setSavingKey("");
    }
  }

  async function mutateSale(body: Record<string, unknown>, successMessage: string) {
    setSavingKey("sale-master");
    try {
      const response = await fetch("/api/admin/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "ECセール項目を保存できませんでした");
      const mutationResult = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (body.action === "create_sale" && !mutationResult.sale) {
        throw new Error("ECセール項目の保存結果を確認できませんでした");
      }
      setPayload((current) => current ? {
        ...current,
        saleOptions: applyShiftSaleMutation(current.saleOptions, body, mutationResult),
      } : current);
      if (savedPayloadRef.current) {
        savedPayloadRef.current = {
          ...savedPayloadRef.current,
          saleOptions: applyShiftSaleMutation(savedPayloadRef.current.saleOptions, body, mutationResult),
        };
      }
      setMessage(successMessage);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ECセール項目を保存できませんでした");
      throw err;
    } finally {
      setSavingKey("");
    }
  }

  async function mutatePattern(body: Record<string, unknown>, successMessage: string) {
    setSavingKey("pattern-master");
    try {
      const response = await fetch("/api/admin/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department, ...body }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "勤務候補を保存できませんでした");
      const mutationResult = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const action = typeof body.action === "string" ? body.action : "";
      if ((action === "create_pattern" || action === "update_pattern") && !mutationResult.pattern) {
        throw new Error("勤務候補の保存結果を確認できませんでした");
      }
      setPayload((current) => current ? {
        ...current,
        patterns: applyShiftPatternMutation(current.patterns, body, mutationResult),
      } : current);
      if (savedPayloadRef.current) {
        savedPayloadRef.current = {
          ...savedPayloadRef.current,
          patterns: applyShiftPatternMutation(savedPayloadRef.current.patterns, body, mutationResult),
        };
      }
      setMessage(successMessage);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "勤務候補を保存できませんでした");
      throw err;
    } finally {
      setSavingKey("");
    }
  }

  async function movePattern(pattern: ShiftPattern, direction: -1 | 1) {
    const patterns = payload?.patterns || [];
    const currentIndex = patterns.findIndex((item) => item.id === pattern.id);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= patterns.length) return;
    const reordered = [...patterns];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    await mutatePattern(
      { action: "reorder_patterns", pattern_ids: reordered.map((item) => item.id) },
      "勤務候補の表示順を更新しました",
    );
  }

  function setCellColorLocal(date: string, cellKey: string, nextColor: string) {
    if (!selectedPeriod || isShiftLocked) return;
    setPayload((current) => current ? {
      ...current,
      cellStyles: [
        ...current.cellStyles.filter((style) => !(style.work_date === date && style.cell_key === cellKey)),
        ...(nextColor ? [{ work_date: date, cell_key: cellKey, background_color: nextColor }] : []),
      ],
    } : current);
    setHasUnsavedChanges(true);
  }

  function coloredCellProps(date: string, cellKey: string) {
    const backgroundColor = cellStyleMap.get(`${date}:${cellKey}`) || undefined;
    const foregroundColor = isDarkCellColor(backgroundColor) ? "#ffffff" : "#0f172a";
    return {
      style: backgroundColor ? {
        "--shift-cell-background": backgroundColor,
        "--shift-cell-foreground": foregroundColor,
        backgroundColor,
        color: foregroundColor,
      } as CSSProperties : undefined,
      "data-shift-cell-colored": backgroundColor ? "true" : undefined,
    };
  }

  function cancelShiftChanges() {
    if (!savedPayloadRef.current || (!hasUnsavedChanges && !isConfirmedNotesEditing) || (isShiftLocked && !isConfirmedNotesEditing)) return;
    if (hasUnsavedChanges) {
      const ok = window.confirm("保存していない変更をすべて取り消します。よろしいですか？");
      if (!ok) return;
    }
    setPayload(cloneShiftPayload(savedPayloadRef.current));
    setHasUnsavedChanges(false);
    setConfirmedNotesEditing(false);
    setMessage(isConfirmedNotesEditing ? "備考修正をキャンセルしました" : "未保存の変更を取り消しました");
  }

  async function saveConfirmedNotes() {
    if (!selectedPeriod || !payload || !savedPayloadRef.current || !isConfirmedNotesEditing) return;
    const savedNotesByDate = new Map(savedPayloadRef.current.requirements.map((requirement) => [
      requirement.work_date,
      confirmedNoteSignature(selectedPeriod.department, requirement),
    ]));
    const requirements = payload.requirements
      .filter((requirement) => {
        return confirmedNoteSignature(selectedPeriod.department, requirement) !== (savedNotesByDate.get(requirement.work_date) || "");
      })
      .map((requirement) => ({
        work_date: requirement.work_date,
        notes: requirement.notes || "",
        notes2: requirement.notes2 || "",
        production_plan: requirement.production_plan || "",
      }));
    if (requirements.length === 0) {
      setConfirmedNotesEditing(false);
      setHasUnsavedChanges(false);
      setMessage("備考の変更はありません");
      return;
    }
    const ok = window.confirm(`確定済みシフトの備考を${requirements.length}日分更新します。よろしいですか？`);
    if (!ok) return;

    setSavingKey("save-confirmed-notes");
    setMessage("");
    try {
      const result = await patch({ action: "update_confirmed_notes", requirements });
      if (Number(result?.updated) !== requirements.length) {
        throw new Error("備考の保存件数が一致しません。画面を再読み込みして確認してください");
      }
      const reloaded = await load(selectedPeriod.id, selectedPeriod.department);
      if (!reloaded) throw new Error("備考は保存されましたが、再読込に失敗しました");
      setMessage(`確定済みシフトの備考を${requirements.length}日分更新しました`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "備考を保存できませんでした");
    } finally {
      setSavingKey("");
    }
  }

  async function saveShiftChanges(finalize: boolean): Promise<boolean> {
    if (!selectedPeriod || !payload || !savedPayloadRef.current || isShiftLocked) return false;
    if (!finalize && !hasUnsavedChanges) return true;
    if (finalize) {
      const ok = window.confirm(hasUnsavedChanges
        ? "未保存の変更を保存してシフトを確定します。確定後は一切変更できません。よろしいですか？"
        : "一時保存済みの内容でシフトを確定します。確定後は一切変更できません。よろしいですか？");
      if (!ok) return false;
    }

    setSavingKey(finalize ? "finalize-shift" : "save-shift");
    setMessage("");
    try {
      const requestChanges = changedShiftRequests(payload.requests || [], savedPayloadRef.current.requests || []);
      const result = await patch({
        action: "save_shift_changes",
        finalize,
        requirements: payload.requirements,
        assignments: payload.assignments,
        request_changes: requestChanges,
        cell_styles: payload.cellStyles,
      });
      const expectedAssignments = payload.assignments.filter((assignment) => !!assignment.shift_label || isCompanyOffAssignment(assignment)).length;
      if (
        Number(result?.requirements) !== payload.requirements.length ||
        Number(result?.assignments) !== expectedAssignments ||
        Number(result?.requestChanges) !== requestChanges.length ||
        Number(result?.cellStyles) !== payload.cellStyles.length
      ) {
        throw new Error("保存件数の照合に失敗しました。画面を再読み込みして内容を確認してください");
      }
      const reloaded = await load(selectedPeriod.id, selectedPeriod.department);
      if (!reloaded) throw new Error("保存は完了しましたが、再読込に失敗しました。画面を再読み込みしてください");
      setMessage(finalize
        ? `シフトを確定保存し、所属スタッフ${Number(result?.confirmationAlerts || 0)}名へ通知しました`
        : "シフトを一時保存しました");
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "シフトを保存できませんでした");
      return false;
    } finally {
      setSavingKey("");
    }
  }

  async function openPrintPreview() {
    if (!selectedPeriod || !payload || savingKey) return;
    const previewUrl = `/admin/shifts/print?period_id=${encodeURIComponent(selectedPeriod.id)}`;
    if (!hasUnsavedChanges) {
      window.open(previewUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const previewWindow = window.open("about:blank", `shift-print-preview-${selectedPeriod.id}`);
    if (!previewWindow) {
      setMessage("印刷プレビューを開けませんでした。ブラウザのポップアップを許可してください");
      return;
    }
    previewWindow.document.title = "シフトを保存中";
    previewWindow.document.body.textContent = "変更を保存して印刷プレビューを準備しています...";

    const saved = await saveShiftChanges(false);
    if (!saved) {
      previewWindow.close();
      return;
    }
    previewWindow.location.replace(previewUrl);
  }

  async function startCollection() {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    const targetIds = Array.from(collectionTargetIds);
    if (targetIds.length === 0) {
      setMessage("希望回収対象を選択してください");
      return;
    }
    setSavingKey("start-collection");
    try {
      const result = await patch({ action: "start_collection", target_user_ids: targetIds });
      setMessage(`希望回収を開始しました（対象${result?.targets || targetIds.length}名）`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "希望回収を開始できませんでした");
    }
    setSavingKey("");
  }

  async function saveRequestDeadline() {
    if (!selectedPeriod || isShiftLocked || !periodDeadlineDraft) return;
    setSavingKey("request-deadline");
    setMessage("");
    try {
      await patch({ action: "update_period", request_deadline: periodDeadlineDraft });
      await load(selectedPeriod.id, selectedPeriod.department);
      setMessage(`希望締切を${periodDeadlineDraft.replaceAll("-", "/")}に変更しました`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "希望締切を変更できませんでした");
    } finally {
      setSavingKey("");
    }
  }

  async function startTestCollection() {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    setSavingKey("test-collection");
    setMessage("");
    try {
      const result = await patch({ action: "start_test_collection" });
      setMessage(`スタッフ${result?.staff || 0}名分の希望をランダム生成しました（休み希望${result?.requests || 0}件）。続けてAI下書きを実行できます`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "希望回収テストを開始できませんでした");
    }
    setSavingKey("");
  }

  function toggleCollectionTarget(userId: string) {
    setCollectionTargetIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function generateDraft() {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    setSavingKey("generate");
    try {
      const result = await patch({ action: "generate_draft", overwrite_ai: true });
      const warningCount = Array.isArray(result?.warnings) ? result.warnings.length : 0;
      const warningPreview = warningCount ? `：${result.warnings.slice(0, 2).join(" / ")}` : "";
      setMessage(`AI下書きを作成しました（${result?.inserted || 0}件${warningCount ? ` / 要確認${warningCount}件` : ""}）${warningPreview}`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "AI下書きを作成できませんでした");
    }
    setSavingKey("");
  }

  async function removePeriodEmployee(employee: ShiftEmployee) {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    const name = displayName(employee);
    const ok = window.confirm(
      `「${name}」をこのシフト期間から外します。\n\nこの期間の希望・割当も削除されます。人事情報と過去シフトは削除されません。`,
    );
    if (!ok) return;

    setSavingKey(`remove-employee:${employee.user_id}`);
    try {
      await patch({ action: "remove_period_employee", user_id: employee.user_id });
      setMessage(`${name}をこのシフト期間から外しました`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "スタッフをシフトから外せませんでした");
    } finally {
      setSavingKey("");
    }
  }

  async function restorePeriodEmployee(employee: ShiftEmployee) {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    setSavingKey(`restore-employee:${employee.user_id}`);
    try {
      await patch({ action: "restore_period_employee", user_id: employee.user_id });
      setMessage(`${displayName(employee)}をシフト対象へ戻しました`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "スタッフをシフトへ戻せませんでした");
    } finally {
      setSavingKey("");
    }
  }

  function updateRequirementLocal(date: string, patchValue: ShiftRequirementUpdate) {
    if (!payload || !selectedPeriod || (isShiftLocked && !isConfirmedNotesEditing)) return;
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = currentPayload.requirements.find((item) => item.work_date === date) || emptyRequirement(selectedPeriod, date);
      const resolvedPatch = typeof patchValue === "function" ? patchValue(current) : patchValue;
      const next = { ...current, ...resolvedPatch };
      return {
        ...currentPayload,
        requirements: currentPayload.requirements.some((item) => item.work_date === date)
          ? currentPayload.requirements.map((item) => item.work_date === date ? next : item)
          : [...currentPayload.requirements, next].sort((a, b) => a.work_date.localeCompare(b.work_date)),
      };
    });
    setHasUnsavedChanges(true);
  }

  function updateAssignmentLocal(employee: ShiftEmployee, date: string, shiftLabel: string) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    const key = `${employee.user_id}:${date}`;
    if (!shiftLabel) {
      setPayload((currentPayload) => {
        if (!currentPayload) return currentPayload;
        const nextAssignments = currentPayload.assignments.filter((item) => !(item.user_id === employee.user_id && item.work_date === date));
        return {
          ...currentPayload,
          assignments: nextAssignments,
          summary: {
            ...currentPayload.summary,
            assignments: nextAssignments.filter((assignment) => !!assignment.shift_label).length,
          },
        };
      });
      setOpenTimeEditorKeys((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
      setHasUnsavedChanges(true);
      return;
    }
    const pattern = patternByLabel.get(shiftLabel);
    const timing = shiftTimingForEmployee(employee, pattern);
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = currentPayload.assignments.find((item) => item.user_id === employee.user_id && item.work_date === date);
      const next: ShiftAssignment = {
        id: current?.id || key,
        period_id: selectedPeriod.id,
        user_id: employee.user_id,
        employee_id: employee.id,
        work_date: date,
        pattern_id: pattern?.id || null,
        shift_label: shiftLabel,
        start_time: timing.startTime || current?.start_time || null,
        end_time: timing.endTime || current?.end_time || null,
        break_minutes: pattern ? timing.breakMinutes : current?.break_minutes ?? 0,
        work_minutes: timing.workMinutes ?? current?.work_minutes ?? null,
        note: isCompanyOffAssignment(current) ? null : current?.note || null,
        source: "manual",
      };
      const nextAssignments = current
        ? currentPayload.assignments.map((item) => item.user_id === employee.user_id && item.work_date === date ? next : item)
        : [...currentPayload.assignments, next];
      return {
        ...currentPayload,
        assignments: nextAssignments,
        summary: {
          ...currentPayload.summary,
          assignments: nextAssignments.filter((assignment) => !!assignment.shift_label).length,
        },
      };
    });
    setHasUnsavedChanges(true);
  }

  function updateAssignmentTimeLocal(
    employee: ShiftEmployee,
    date: string,
    patchValue: Partial<Pick<ShiftAssignment, "start_time" | "end_time" | "break_minutes">>,
  ) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = currentPayload.assignments.find((item) => item.user_id === employee.user_id && item.work_date === date);
      if (!current?.shift_label) return currentPayload;
      const nextStart = patchValue.start_time !== undefined ? patchValue.start_time : current.start_time;
      const nextEnd = patchValue.end_time !== undefined ? patchValue.end_time : current.end_time;
      const nextBreak = patchValue.break_minutes !== undefined ? patchValue.break_minutes : current.break_minutes;
      const next: ShiftAssignment = {
        ...current,
        shift_label: nextStart && nextEnd ? `${nextStart}-${nextEnd}` : current.shift_label,
        start_time: nextStart,
        end_time: nextEnd,
        break_minutes: Math.max(0, Math.min(480, Math.round(Number(nextBreak) || 0))),
        work_minutes: null,
        source: "manual",
      };
      return {
        ...currentPayload,
        assignments: currentPayload.assignments.map((item) => item.user_id === employee.user_id && item.work_date === date ? next : item),
      };
    });
    setHasUnsavedChanges(true);
  }

  function toggleTimeEditor(employee: ShiftEmployee, date: string) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    const key = `${employee.user_id}:${date}`;
    const current = assignmentMap.get(key);
    if (!current?.shift_label) updateAssignmentLocal(employee, date, "自由入力");
    setOpenTimeEditorKeys((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setCompanyOffLocal(employee: ShiftEmployee, date: string) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    const key = `${employee.user_id}:${date}`;
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = currentPayload.assignments.find((item) => item.user_id === employee.user_id && item.work_date === date);
      if (isCompanyOffAssignment(current)) return currentPayload;
      const companyOff: ShiftAssignment = {
        id: current?.id || `company-off-${key}`,
        period_id: selectedPeriod.id,
        user_id: employee.user_id,
        employee_id: employee.id,
        work_date: date,
        pattern_id: null,
        shift_label: null,
        start_time: null,
        end_time: null,
        break_minutes: 0,
        work_minutes: null,
        note: SHIFT_COMPANY_OFF_NOTE,
        source: "manual",
      };
      const nextAssignments = current
        ? currentPayload.assignments.map((item) => item.user_id === employee.user_id && item.work_date === date ? companyOff : item)
        : [...currentPayload.assignments, companyOff];
      return {
        ...currentPayload,
        assignments: nextAssignments,
        summary: {
          ...currentPayload.summary,
          assignments: nextAssignments.filter((assignment) => !!assignment.shift_label).length,
        },
      };
    });
    setOpenTimeEditorKeys((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    setHasUnsavedChanges(true);
  }

  function updateRequestLocal(employee: ShiftEmployee, date: string, blocked: boolean) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    const key = `${employee.user_id}:${date}`;
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = (currentPayload.requests || []).find((request) => request.user_id === employee.user_id && request.work_date === date);
      const nextRequests = (currentPayload.requests || []).filter((request) => !(request.user_id === employee.user_id && request.work_date === date));
      const nextAssignments = blocked
        ? (currentPayload.assignments || []).filter((assignment) => !(assignment.user_id === employee.user_id && assignment.work_date === date))
        : currentPayload.assignments;

      if (blocked) {
        nextRequests.push({
          id: current?.id || `request-${key}`,
          period_id: selectedPeriod.id,
          user_id: employee.user_id,
          employee_id: employee.id,
          work_date: date,
          request_type: "unavailable",
          priority: "must",
          start_time: null,
          end_time: null,
          memo: current?.memo || null,
        });
      }

      return {
        ...currentPayload,
        requests: nextRequests.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.user_id.localeCompare(b.user_id)),
        assignments: nextAssignments,
        summary: {
          ...currentPayload.summary,
          requests: nextRequests.length,
          assignments: nextAssignments.filter((assignment) => !!assignment.shift_label).length,
        },
      };
    });
    setHasUnsavedChanges(true);
  }

  function setPaidLeaveRequestLocal(
    employee: ShiftEmployee,
    date: string,
    requestType: "" | "paid_leave_full" | "paid_leave_half",
  ) {
    if (!payload || !selectedPeriod || isShiftLocked) return;
    const key = `${employee.user_id}:${date}`;
    setPayload((currentPayload) => {
      if (!currentPayload) return currentPayload;
      const current = (currentPayload.requests || []).find((request) => (
        request.user_id === employee.user_id && request.work_date === date
      ));
      const nextRequests = (currentPayload.requests || []).filter((request) => !(
        request.user_id === employee.user_id && request.work_date === date
      ));
      if (requestType) {
        nextRequests.push({
          id: current?.id || `paid-leave-${key}`,
          period_id: selectedPeriod.id,
          user_id: employee.user_id,
          employee_id: employee.id,
          work_date: date,
          request_type: requestType,
          priority: "must",
          start_time: null,
          end_time: null,
          memo: current?.memo || null,
        });
      }
      const nextAssignments = requestType === "paid_leave_full"
        ? currentPayload.assignments.filter((assignment) => !(
          assignment.user_id === employee.user_id && assignment.work_date === date
        ))
        : currentPayload.assignments;
      return {
        ...currentPayload,
        requests: nextRequests.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.user_id.localeCompare(b.user_id)),
        assignments: nextAssignments,
        summary: {
          ...currentPayload.summary,
          requests: nextRequests.length,
          assignments: nextAssignments.filter((assignment) => !!assignment.shift_label).length,
        },
      };
    });
    setHasUnsavedChanges(true);
    const label = requestType === "paid_leave_full" ? "有給全休" : requestType === "paid_leave_half" ? "有給半休" : "有給設定なし";
    setMessage(`${displayName(employee)} ${formatDateShort(date)} を${label}に変更しました（未保存）`);
  }

  function toggleAdminRequest(employee: ShiftEmployee, date: string) {
    if (!selectedPeriod || isShiftLocked) return;
    const request = requestMap.get(`${employee.user_id}:${date}`);
    const isBlocked = request?.request_type === "day_off" || request?.request_type === "unavailable" || request?.request_type === "paid_leave_full";
    const nextBlocked = !isBlocked;
    updateRequestLocal(employee, date, nextBlocked);
    setMessage(nextBlocked ? `${displayName(employee)} ${formatDateShort(date)} を休みに変更しました（未保存）` : `${displayName(employee)} ${formatDateShort(date)} の休みを解除しました（未保存）`);
  }

  async function resetShift(periodToReset = selectedPeriod) {
    if (!periodToReset || ["confirmed", "exported", "archived"].includes(periodToReset.status)) return;
    const ok = window.confirm(`「${periodTitle(periodToReset)}」の勤務割当と会社休だけをすべて消し、AI下書き前の未設定状態に戻します。\n\n提出済みの希望休・回収状況・自由記入・日別条件は残ります。実行しますか？`);
    if (!ok) return;
    setSavingKey(`reset-shift:${periodToReset.id}`);
    setMessage("");
    try {
      await patchPeriod(periodToReset.id, { action: "reset_shift" });
      await load(periodToReset.id, periodToReset.department);
      setMessage("シフトを未設定状態へリセットしました。希望回収データは残っています。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "シフトをリセットできませんでした");
    } finally {
      setSavingKey("");
    }
  }

  async function clearRequests() {
    if (!selectedPeriod || isShiftLocked || hasUnsavedChanges) return;
    const ok = window.confirm("このシフトの希望提出データと回収対象を削除し、スタッフのホーム表示も消します。実行しますか？");
    if (!ok) return;
    setSavingKey("clear-requests");
    try {
      const result = await patch({ action: "clear_requests" });
      setMessage(`希望回収を解除しました（希望${result?.deletedRequests || 0}件 / 提出済み${result?.deletedSubmissions || 0}件 / 対象${result?.deletedTargets || 0}件）`);
      await load(selectedPeriod.id, selectedPeriod.department);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "希望を削除できませんでした");
    }
    setSavingKey("");
  }

  async function openShiftPeriod(period: ShiftPeriod) {
    if (hasUnsavedChanges && !window.confirm("一時保存していない変更を破棄して、別のシフトを開きますか？")) return;
    setHasUnsavedChanges(false);
    setPeriodId(period.id);
    await load(period.id, period.department);
  }

  async function deleteShiftPeriod(periodToDelete = selectedPeriod) {
    if (!periodToDelete) return;
    if (periodToDelete.id === selectedPeriod?.id && hasUnsavedChanges) return;
    const isFinalized = ["confirmed", "exported", "archived"].includes(periodToDelete.status);
    const warning = isFinalized
      ? `【警告：確定済みシフト】\n\n「${periodTitle(periodToDelete)}」を期間ごと完全に削除します。\n公開済みシフト・希望・日別条件・勤務割当もすべて削除され、元に戻せません。\n\n本当に削除しますか？`
      : `「${periodTitle(periodToDelete)}」をシフト期間ごと削除します。希望・日別条件・割当も削除されます。実行しますか？`;
    const ok = window.confirm(warning);
    if (!ok) return;
    setSavingKey(`delete-period:${periodToDelete.id}`);
    setMessage("");
    let deletionCompleted = false;
    try {
      const result = await patchPeriod(periodToDelete.id, { action: "delete_period" });
      if (!result?.deleted || result.deleted_period_id !== periodToDelete.id) {
        throw new Error("削除結果を確認できませんでした。画面を再読み込みしてください");
      }
      deletionCompleted = true;

      const deletingSelectedPeriod = periodToDelete.id === selectedPeriod?.id;
      const nextPeriodId = deletingSelectedPeriod
        ? payload?.periods.find((period) => period.id !== periodToDelete.id && period.department === periodToDelete.department)?.id || ""
        : periodId;
      const reloaded = await load(nextPeriodId, periodToDelete.department);
      setMessage(reloaded
        ? `${periodTitle(periodToDelete)}を削除しました`
        : "シフト期間は削除済みです。画面を再読み込みしてください");
    } catch (err) {
      setMessage(deletionCompleted
        ? "シフト期間は削除済みですが、画面の更新に失敗しました。再読み込みしてください"
        : err instanceof Error ? err.message : "シフト期間を削除できませんでした");
    } finally {
      setSavingKey("");
    }
  }

  function renderAssignmentTimeEditor(employee: ShiftEmployee, date: string, assignment: ShiftAssignment | undefined, disabled: boolean) {
    const key = `${employee.user_id}:${date}`;
    const isOpen = selectedPeriod?.department === "製造" || openTimeEditorKeys.has(key);
    if (!isOpen || !assignment?.shift_label || isCompanyOffAssignment(assignment)) return null;
    const name = displayName(employee);
    return (
      <div className="shift-assignment-time" aria-label={`${name} ${formatDateShort(date)}の勤務時間`}>
        <input
          type="time"
          value={assignment.start_time?.slice(0, 5) || ""}
          onChange={(event) => updateAssignmentTimeLocal(employee, date, { start_time: event.target.value || null })}
          disabled={disabled}
          aria-label={`${name}の開始時刻`}
          title="開始時刻"
        />
        <span aria-hidden="true">-</span>
        <input
          type="time"
          value={assignment.end_time?.slice(0, 5) || ""}
          onChange={(event) => updateAssignmentTimeLocal(employee, date, { end_time: event.target.value || null })}
          disabled={disabled}
          aria-label={`${name}の終了時刻`}
          title="終了時刻"
        />
        <label title="休憩時間（分）">
          <input
            type="number"
            min="0"
            max="480"
            step="15"
            inputMode="numeric"
            value={assignment.break_minutes}
            onChange={(event) => updateAssignmentTimeLocal(employee, date, { break_minutes: Number(event.target.value) || 0 })}
            disabled={disabled}
            aria-label={`${name}の休憩時間（分）`}
          />
          <small>分</small>
        </label>
      </div>
    );
  }

  const dates = useMemo(() => {
    if (!selectedPeriod) return [];
    const list: string[] = [];
    let current = selectedPeriod.start_date;
    while (current <= selectedPeriod.end_date) {
      list.push(current);
      current = addDays(current, 1);
    }
    return list;
  }, [selectedPeriod]);

  return (
    <div className="shift-admin">
      <section className="shift-admin__panel">
        <div className="shift-admin__header">
          <div>
            <p className="admin-eyebrow">Shift Management</p>
            <h2>シフト作成</h2>
            <p>休み希望を回収し、所属ごとのシフト表を作成・出力します。</p>
          </div>
          {selectedPeriod && (
            <div className="shift-status">
              <span>{STATUS_LABELS[selectedPeriod.status]}</span>
              <strong>{selectedPeriod.department}</strong>
            </div>
          )}
        </div>

        <nav className="shift-department-tabs" aria-label="シフトを作成する所属">
          {USER_DEPARTMENTS.map((item) => {
            const meta = DEPARTMENT_SHIFT_META[item];
            const isActive = department === item;
            return (
              <button
                key={item}
                className={`shift-department-tab ${meta.tabClassName}${isActive ? " shift-department-tab--active" : ""}`}
                type="button"
                aria-pressed={isActive}
                disabled={isLoading}
                onClick={() => switchDepartment(item)}
              >
                <meta.Icon size={19} aria-hidden="true" />
                <span>
                  <strong>{item}</strong>
                  <small>{meta.description}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="shift-department-context" aria-live="polite">
          <div>
            <span>選択中</span>
            <strong>{department}</strong>
            <small>{payload?.employees.length || 0}名</small>
          </div>
          <div className="shift-registered-times">
            <span>登録勤務時間</span>
            {registeredShiftTimes.length === 0 ? (
              <small>{isLoading ? "読み込み中" : "時間候補なし"}</small>
            ) : (
              <>
                {registeredShiftTimes.slice(0, 7).map((time) => <small key={time}>{time}</small>)}
                {registeredShiftTimes.length > 7 && <small>ほか{registeredShiftTimes.length - 7}件</small>}
              </>
            )}
          </div>
        </div>

        <ShiftPatternManager
          key={department}
          department={department}
          patterns={payload?.patterns || []}
          disabled={isLoading || !!savingKey}
          saving={savingKey === "pattern-master"}
          onCreate={(draft) => mutatePattern(
            { action: "create_pattern", ...draft },
            `${department}の勤務候補を追加しました`,
          )}
          onUpdate={(pattern, draft) => mutatePattern(
            { action: "update_pattern", pattern_id: pattern.id, ...draft },
            `${department}の勤務候補を更新しました`,
          )}
          onDelete={async (pattern) => {
            if (!window.confirm(`「${pattern.label}」を今後の選択候補から削除しますか？\n保存済みシフトの表示は残ります。`)) return;
            await mutatePattern(
              { action: "delete_pattern", pattern_id: pattern.id },
              `${department}の勤務候補を削除しました`,
            );
          }}
          onMove={movePattern}
        />

        <div className="shift-admin-section shift-admin-section--create shift-admin-section--create-only">
            <div className="shift-admin-section__title">
              <span>新規</span>
              <h3>シフト期間を作る</h3>
            </div>
            <div className="shift-half-buttons">
              <button className="admin-btn-outline" type="button" onClick={() => applyHalf("first")}>
                前半 1〜15日
              </button>
              <button className="admin-btn-outline" type="button" onClick={() => applyHalf("second")}>
                後半 16〜月末
              </button>
            </div>
            <div className="shift-create-grid">
              <div className="shift-generated-title">
                <span>自動生成名</span>
                <strong>{newPeriodTitle}</strong>
              </div>
              <label className="shift-field">
                <span>開始日</span>
                <input
                  className="form-input"
                  type="date"
                  value={form.start_date}
                  onChange={(event) => {
                    const startDate = event.target.value;
                    setForm({ ...form, start_date: startDate });
                  }}
                />
              </label>
              <label className="shift-field">
                <span>終了日</span>
                <input
                  className="form-input"
                  type="date"
                  value={form.end_date}
                  onChange={(event) => {
                    const endDate = event.target.value;
                    setForm({ ...form, end_date: endDate });
                  }}
                />
              </label>
              <label className="shift-field">
                <span>希望締切</span>
                <input className="form-input" type="date" value={form.request_deadline} onChange={(event) => setForm({ ...form, request_deadline: event.target.value })} />
              </label>
              <button className="btn-primary shift-create-btn" type="button" onClick={createPeriod} disabled={savingKey === "create" || isLoading || hasUnsavedChanges}>
                作成
              </button>
            </div>
        </div>

        {message && <div className="admin-message">{message}</div>}

        {department === "フロア" && (
          <>
            <button type="button" className="shift-sale-manager-trigger" onClick={() => setSaleManagerOpen(true)}>
              <Pencil size={15} aria-hidden="true" />
              <span>ECセール名を編集</span>
              <small>{(payload?.saleOptions || []).filter((sale) => sale.is_active).length}件</small>
            </button>
            <ShiftEcSaleManager
              open={saleManagerOpen}
              onOpenChange={setSaleManagerOpen}
              options={payload?.saleOptions || []}
              disabled={!!savingKey}
              disabledReason={savingKey ? "保存処理中です。" : ""}
              onCreate={(label, color) => mutateSale(
                { action: "create_sale", label, color },
                "ECセール項目を追加しました",
              )}
              onUpdate={(sale, label, color) => mutateSale(
                { action: "update_sale", sale_id: sale.id, label, color },
                "ECセール項目を更新しました",
              )}
              onToggle={async (sale) => {
                if (sale.is_active && !window.confirm(`「${sale.label}」を今後のECセール候補から削除しますか？\n保存済みシフトの表示は残ります。`)) return;
                await mutateSale(
                  { action: sale.is_active ? "delete_sale" : "restore_sale", sale_id: sale.id },
                  sale.is_active ? "ECセール項目を削除しました" : "ECセール項目を再表示しました",
                );
              }}
            />
          </>
        )}

        <div className="shift-period-list-section">
          <div className="shift-admin-section__title">
            <span>一覧</span>
            <h3>作成済みシフト</h3>
          </div>
          <div className="shift-period-list">
            {allPeriods.length === 0 && <p>作成済みシフトはありません。</p>}
            {visiblePeriods.map((period) => (
              <div key={period.id} className={period.id === selectedPeriod?.id ? "shift-period-list__item shift-period-list__item--active" : "shift-period-list__item"}>
                <button type="button" className="shift-period-list__main" onClick={() => openShiftPeriod(period)}>
                  <strong>{periodTitle(period)}</strong>
                  <span>{period.is_test_mode ? "テストモード / " : ""}{STATUS_LABELS[period.status]} / 希望締切 {period.request_deadline || "未設定"}</span>
                </button>
                <div className="shift-period-list__actions">
                  <button
                    type="button"
                    className="admin-btn-outline shift-period-list__reset"
                    onClick={() => void resetShift(period)}
                    disabled={!!savingKey || ["confirmed", "exported", "archived"].includes(period.status)}
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    シフトのみリセット
                  </button>
                  <button
                    type="button"
                    className="admin-btn-danger shift-period-list__delete"
                    onClick={() => deleteShiftPeriod(period)}
                    disabled={!!savingKey || (period.id === selectedPeriod?.id && hasUnsavedChanges)}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
          {allPeriods.length > 5 && (
            <button
              type="button"
              className="admin-btn-outline shift-period-list-toggle"
              onClick={() => setShowAllPeriods((current) => !current)}
            >
              {showAllPeriods ? "最新5件に戻す" : `過去のシフトを表示（残り${allPeriods.length - 5}件）`}
            </button>
          )}
        </div>
      </section>

      {selectedPeriod && (
        <>
          <section className="shift-admin__panel shift-admin__actions">
            {selectedPeriod.is_test_mode && (
              <div className="shift-test-banner">
                <strong>希望回収テスト中</strong>
                <span>選択した管理者だけに実際の希望入力画面を表示しています。通常のスタッフには配信されません。</span>
              </div>
            )}
            <div className="shift-summary">
              <span>日数 <strong>{payload?.summary.days || dates.length}</strong></span>
              <span>スタッフ <strong>{payload?.summary.staff || 0}</strong></span>
              <span>対象 <strong>{targetUserIds.size || collectionTargetIds.size}</strong></span>
              <span>提出 <strong>{payload?.summary.submissions || 0}</strong></span>
              <span>希望 <strong>{payload?.summary.requests || 0}</strong></span>
              <span>割当 <strong>{payload?.summary.assignments || 0}</strong></span>
            </div>
            <div className="shift-period-deadline-editor">
              <label>
                <span>希望締切</span>
                <input
                  className="form-input"
                  type="date"
                  value={periodDeadlineDraft}
                  onChange={(event) => setPeriodDeadlineDraft(event.target.value)}
                  disabled={!!savingKey || isShiftLocked}
                />
              </label>
              <button
                type="button"
                className="admin-btn-outline"
                onClick={saveRequestDeadline}
                disabled={!!savingKey || isShiftLocked || !periodDeadlineDraft || periodDeadlineDraft === selectedPeriod.request_deadline}
              >
                {savingKey === "request-deadline" ? "保存中..." : "締切を保存"}
              </button>
            </div>
            <div className="shift-action-row">
              <div className="shift-action-row__primary">
                <button className="admin-btn-outline" type="button" onClick={startCollection} disabled={!!savingKey || isShiftLocked || hasUnsavedChanges}>
                  希望回収
                </button>
                <button
                  className="admin-btn-outline shift-test-button"
                  type="button"
                  onClick={startTestCollection}
                  disabled={!!savingKey || isShiftLocked || hasUnsavedChanges}
                >
                  {savingKey === "test-collection" ? "テスト希望を生成中..." : "希望回収テスト"}
                </button>
                <a className="admin-btn-outline" href="/shifts">
                  スタッフ画面
                </a>
                <button className="admin-btn-outline" type="button" onClick={generateDraft} disabled={!!savingKey || isShiftLocked || hasUnsavedChanges}>
                  AI下書き
                </button>
                <a className="admin-btn-outline" href={`/api/admin/shifts/export?period_id=${encodeURIComponent(selectedPeriod.id)}`}>
                  Excel出力
                </a>
                <button
                  type="button"
                  className="admin-btn-outline"
                  onClick={() => void openPrintPreview()}
                  disabled={!!savingKey}
                >
                  <Printer size={15} aria-hidden="true" />
                  印刷プレビュー
                </button>
              </div>
              <div className="shift-action-row__danger">
                <button className="admin-btn-danger" type="button" onClick={clearRequests} disabled={!!savingKey || isShiftLocked || hasUnsavedChanges}>
                  希望全削除
                </button>
                <button className="admin-btn-danger" type="button" onClick={() => deleteShiftPeriod()} disabled={!!savingKey || hasUnsavedChanges}>
                  期間削除
                </button>
              </div>
            </div>
            <div className={`shift-save-bar${isShiftLocked && !isConfirmedNotesEditing ? " shift-save-bar--locked" : hasUnsavedChanges ? " shift-save-bar--dirty" : ""}`}>
              <div className="shift-save-bar__status">
                {isConfirmedNotesEditing ? <Pencil size={20} aria-hidden="true" /> : isShiftLocked ? <LockKeyhole size={20} aria-hidden="true" /> : hasUnsavedChanges ? <Save size={20} aria-hidden="true" /> : <CheckCircle2 size={20} aria-hidden="true" />}
                <span>
                  <strong>{isConfirmedNotesEditing ? "確定済みシフトの備考を修正中" : isShiftLocked ? "確定保存済み" : hasUnsavedChanges ? "未保存の変更があります" : selectedPeriod.status === "editing" ? "一時保存済み" : "保存済み"}</strong>
                  <small>{isConfirmedNotesEditing ? "勤務時間・休みはロックしたまま、備考だけ修正できます。" : isShiftLocked ? "勤務内容はロックされています。確定状態では備考のみ修正できます。" : "一時保存後は再編集できます。確定保存後は勤務内容を変更できません。"}</small>
                </span>
              </div>
              <div className="shift-save-bar__actions">
                {isShiftLocked ? (
                  isConfirmedNotesEditing ? (
                    <>
                      <button type="button" className="admin-btn-outline" onClick={cancelShiftChanges} disabled={!!savingKey}>
                        <Undo2 size={17} aria-hidden="true" />
                        修正をキャンセル
                      </button>
                      <button type="button" className="btn-primary shift-save-bar__final" onClick={() => void saveConfirmedNotes()} disabled={!hasUnsavedChanges || !!savingKey}>
                        <Save size={18} aria-hidden="true" />
                        {savingKey === "save-confirmed-notes" ? "保存中..." : "備考修正を保存"}
                      </button>
                    </>
                  ) : canEditConfirmedNotes ? (
                    <button type="button" className="btn-primary shift-save-bar__final" onClick={() => {
                      setConfirmedNotesEditing(true);
                      setMessage("確定済みシフトの備考を修正できます");
                    }} disabled={!!savingKey}>
                      <Pencil size={18} aria-hidden="true" />
                      備考を修正
                    </button>
                  ) : null
                ) : (
                  <>
                    <button type="button" className="admin-btn-danger shift-save-bar__reset" onClick={() => void resetShift()} disabled={!!savingKey}>
                      <RotateCcw size={17} aria-hidden="true" />
                      シフトをリセット
                    </button>
                    <button type="button" className="admin-btn-outline" onClick={cancelShiftChanges} disabled={!hasUnsavedChanges || !!savingKey}>
                      <Undo2 size={17} aria-hidden="true" />
                      変更をキャンセル
                    </button>
                    <button type="button" className="admin-btn-outline shift-save-bar__temporary" onClick={() => void saveShiftChanges(false)} disabled={!hasUnsavedChanges || !!savingKey}>
                      <Save size={17} aria-hidden="true" />
                      一時保存
                    </button>
                    <button type="button" className="btn-primary shift-save-bar__final" onClick={() => void saveShiftChanges(true)} disabled={!!savingKey || selectedPeriod.is_test_mode}>
                      <CheckCircle2 size={18} aria-hidden="true" />
                      確定保存
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="shift-collect-help">
              通常の希望回収は対象スタッフへ配信します。「希望回収テスト」はスタッフへ表示せず、全員分の休み希望と勤務条件をランダム生成してAI下書きの動作確認に使います。
            </p>
            {(payload?.summary.warnings || []).length > 0 && (
              <div className="shift-warnings">
                {(payload?.summary.warnings || []).slice(0, 12).map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            )}
          </section>

          <section className="shift-admin__panel">
            <div className="shift-table-heading">
              <div>
                <h3>希望回収対象・状況</h3>
                <p>対象者を選んで希望回収を開始します。提出済み、希望件数、未提出がここで分かります。</p>
              </div>
              <div className="shift-page-switch">
                <button type="button" className="admin-btn-outline" onClick={() => setCollectionTargetIds(new Set(collectionEmployees.map((employee) => employee.user_id)))}>
                  全員選択
                </button>
                <button type="button" className="admin-btn-outline" onClick={() => setCollectionTargetIds(new Set())}>
                  全解除
                </button>
              </div>
            </div>
            <div className="shift-collection-grid">
              {collectionEmployees.map((employee) => {
                const isTarget = collectionTargetIds.has(employee.user_id);
                const isStoredTarget = effectiveTargetUserIds.has(employee.user_id);
                const isSubmitted = submittedUserIds.has(employee.user_id);
                const requestCount = requestCountByUser.get(employee.user_id) || 0;
                const submission = submissionByUserId.get(employee.user_id);
                const constraints = resolveShiftConstraints(employee.work_style, dates.length, {
                  maxWorkDays: submission?.max_work_days,
                  targetWorkDays: submission?.target_work_days,
                  minDaysOff: submission?.min_days_off,
                  maxConsecutiveDays: submission?.max_consecutive_days,
                });
                return (
                  <button
                    key={employee.user_id}
                    type="button"
                    className={`shift-collection-user${isTarget ? " shift-collection-user--selected" : ""}${isSubmitted ? " shift-collection-user--submitted" : ""}`}
                    onClick={() => toggleCollectionTarget(employee.user_id)}
                  >
                    <strong>{displayName(employee)}</strong>
                    <span>{employee.employee_code || "NO未設定"} / {workStyleLabel(employee.work_style)}</span>
                    <em>{submission?.is_test ? "テスト希望" : isSubmitted ? "希望回収済み" : isStoredTarget ? "未提出" : "未送信"}</em>
                    {requestCount > 0 && <small>希望 {requestCount}件</small>}
                    {submission && (
                      <small className="shift-collection-user__constraints">
                        希望{constraints.targetWorkDays}日 / 上限{constraints.effectiveMaxWorkDays}日 / 休日{constraints.minDaysOff}日 / 最大{constraints.maxConsecutiveDays}連勤
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="shift-admin__panel">
            <div className="shift-table-heading">
              <div>
                <h3>シフト表</h3>
                <p>正社員は基本勤務系、パートは時間帯候補を表示します。候補以外の文字も保存できます。</p>
              </div>
              {employeePages.length > 1 && (
                <div className="shift-page-switch" aria-label="表示スタッフ切替">
                  {employeePages.map((page, index) => (
                    <button
                      key={index}
                      type="button"
                      className={shiftEmployeePage === index ? "shift-page-switch__btn shift-page-switch__btn--active" : "shift-page-switch__btn"}
                      onClick={() => setShiftEmployeePage(index)}
                    >
                      {selectedPeriod.department} {index + 1}/{employeePages.length}
                      <span>{page.map((employee) => displayName(employee)).join("・")}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="shift-period-roster">
              <div className="shift-period-roster__header">
                <div>
                  <h4>シフト対象スタッフ</h4>
                  <small>ハンドルをドラッグして表示順を変更</small>
                </div>
                <span>{payload?.employees.length || 0}名</span>
              </div>
              <div className="shift-period-roster__grid">
                {(payload?.employees || []).map((employee) => (
                  <div
                    key={`roster-${employee.user_id}`}
                    className={`shift-period-roster__item${draggedEmployeeId === employee.user_id ? " shift-period-roster__item--dragging" : ""}${dragOverEmployeeId === employee.user_id ? " shift-period-roster__item--drag-over" : ""}`}
                    onDragEnter={() => setDragOverEmployeeId(employee.user_id)}
                    onDragOver={(event) => {
                      if (!shiftControlsDisabled) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => void handleEmployeeDrop(event, employee.user_id)}
                  >
                    <button
                      type="button"
                      className="shift-period-roster__drag"
                      draggable={!shiftControlsDisabled}
                      disabled={shiftControlsDisabled}
                      onDragStart={(event) => handleEmployeeDragStart(event, employee.user_id)}
                      onDragEnd={handleEmployeeDragEnd}
                      title={`${displayName(employee)}をドラッグして並べ替え`}
                      aria-label={`${displayName(employee)}をドラッグして並べ替え`}
                    >
                      <GripVertical size={17} aria-hidden="true" />
                    </button>
                    <span>
                      <strong>{displayName(employee)}</strong>
                      <small>{employee.employee_code || "NO未設定"} / {workStyleLabel(employee.work_style)}</small>
                    </span>
                    <button
                      type="button"
                      className="shift-period-roster__remove"
                      onClick={() => void removePeriodEmployee(employee)}
                      disabled={shiftControlsDisabled || hasUnsavedChanges}
                      title={`${displayName(employee)}をこのシフトから外す`}
                      aria-label={`${displayName(employee)}をこのシフトから外す`}
                    >
                      <UserMinus size={17} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              {(payload?.excludedEmployees || []).length > 0 && (
                <details className="shift-period-roster__excluded">
                  <summary>除外済みスタッフ（{payload?.excludedEmployees.length || 0}名）</summary>
                  <div className="shift-period-roster__grid">
                    {(payload?.excludedEmployees || []).map((employee) => (
                      <div key={`excluded-${employee.user_id}`} className="shift-period-roster__item shift-period-roster__item--excluded">
                        <span>
                          <strong>{displayName(employee)}</strong>
                          <small>{employee.employee_code || "NO未設定"}</small>
                        </span>
                        <button
                          type="button"
                          className="shift-period-roster__restore"
                          onClick={() => void restorePeriodEmployee(employee)}
                          disabled={shiftControlsDisabled || hasUnsavedChanges}
                          title={`${displayName(employee)}をシフトへ戻す`}
                          aria-label={`${displayName(employee)}をシフトへ戻す`}
                        >
                          <RotateCcw size={17} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            <div
              className={`shift-grid-wrap${selectedPeriod.department === "フロア" ? " shift-grid-wrap--floor" : ""}${employeePages.length > 1 ? " shift-grid-wrap--paged" : ""}`}
              role="region"
              aria-label="スタッフ名を固定したシフト表"
              tabIndex={0}
            >
              <table className={`shift-grid-table${isCompactShiftTable ? " shift-grid-table--compact" : ""}${selectedPeriod.department === "フロア" ? " shift-grid-table--floor" : ""}${selectedPeriod.department === "製造" ? " shift-grid-table--manufacturing" : ""}${selectedPeriod.department === "道の駅" ? " shift-grid-table--road-station" : ""}`}>
                <thead>
                  <tr>
                    <th className="shift-sticky-col">日付</th>
                    <th>必要</th>
                    {visibleShiftEmployees.map((employee) => (
                      <th
                        key={employee.user_id}
                        className={dragOverEmployeeId === employee.user_id ? "shift-employee-heading shift-employee-heading--drag-over" : "shift-employee-heading"}
                        onDragEnter={() => setDragOverEmployeeId(employee.user_id)}
                        onDragOver={(event) => {
                          if (!shiftControlsDisabled) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }
                        }}
                        onDrop={(event) => void handleEmployeeDrop(event, employee.user_id)}
                      >
                        <span className="shift-employee-heading__name">
                          <button
                            type="button"
                            className="shift-employee-heading__drag"
                            draggable={!shiftControlsDisabled}
                            disabled={shiftControlsDisabled}
                            onDragStart={(event) => handleEmployeeDragStart(event, employee.user_id)}
                            onDragEnd={handleEmployeeDragEnd}
                            title={`${displayName(employee)}をドラッグして並べ替え`}
                            aria-label={`${displayName(employee)}をドラッグして並べ替え`}
                          >
                            <GripVertical size={15} aria-hidden="true" />
                          </button>
                          <b>{displayName(employee)}</b>
                        </span>
                        <small>{employee.employee_code || "NO未設定"} / {workStyleLabel(employee.work_style)}</small>
                        {selectedPeriod.department === "製造" && employee.basic_work_start && employee.basic_work_end && (
                          <small className="shift-basic-time">基本 {employee.basic_work_start.slice(0, 5)}-{employee.basic_work_end.slice(0, 5)} / 休憩{employee.basic_break_minutes ?? 0}分</small>
                        )}
                        {effectiveTargetUserIds.has(employee.user_id) && (
                          <em className={submittedUserIds.has(employee.user_id) ? "shift-submitted-badge" : "shift-submitted-badge shift-submitted-badge--pending"}>
                            {submittedUserIds.has(employee.user_id) ? "希望回収済み" : "未提出"}
                          </em>
                        )}
                      </th>
                    ))}
                    <th>{selectedPeriod.department === "道の駅" ? "Timee（内容・時刻）" : "Timee"}</th>
                    {selectedPeriod.department === "製造" ? (
                      <>
                        <th>備考1</th>
                        <th>備考2</th>
                      </>
                    ) : (
                      <th>{selectedPeriod.department === "道の駅" ? "備考" : "ECセール / 備考2"}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {dates.map((date) => {
                    const requirement = requirementMap.get(date) || emptyRequirement(selectedPeriod, date);
                    return (
                      <tr key={date}>
                        <td
                          className="shift-sticky-col shift-date-cell"
                          aria-label={`${formatDateShort(date)}の日付セル`}
                          {...coloredCellProps(date, "date")}
                        >
                          <div className="shift-date-cell__heading">
                            <strong>{formatDateShort(date)}</strong>
                            <ShiftDateColorPicker
                              currentColor={cellStyleMap.get(`${date}:date`)}
                              disabled={shiftControlsDisabled}
                              label={`${formatDateShort(date)}の日付セル`}
                              onChange={(color) => setCellColorLocal(date, "date", color)}
                            />
                          </div>
                          <input
                            className="shift-mini-input"
                            value={requirement.workplace_label || ""}
                            onChange={(event) => updateRequirementLocal(date, { workplace_label: event.target.value })}
                            disabled={shiftControlsDisabled}
                            placeholder="場所"
                          />
                        </td>
                        <td className="shift-colorable-cell" {...coloredCellProps(date, "required")}>
                          <ShiftCellColorPicker
                            currentColor={cellStyleMap.get(`${date}:required`)}
                            disabled={shiftControlsDisabled}
                            label={`${formatDateShort(date)}の必要人数セル`}
                            onChange={(color) => setCellColorLocal(date, "required", color)}
                          />
                          <input
                            className="shift-count-input"
                            inputMode="decimal"
                            value={requirement.required_count ?? ""}
                            onChange={(event) => updateRequirementLocal(date, { required_count: event.target.value })}
                            disabled={shiftControlsDisabled}
                          />
                        </td>
                        {visibleShiftEmployees.map((employee) => {
                          const assignment = assignmentMap.get(`${employee.user_id}:${date}`);
                          const request = requestMap.get(`${employee.user_id}:${date}`);
                          const beforeHire = isBeforeHireDate(employee, date);
                          const requestedOff = request?.request_type === "day_off" || request?.request_type === "unavailable";
                          const paidLeaveFull = request?.request_type === "paid_leave_full";
                          const paidLeaveType = request?.request_type === "paid_leave_full" || request?.request_type === "paid_leave_half"
                            ? request.request_type
                            : "";
                          const isBlocked = beforeHire || requestedOff || paidLeaveFull;
                          const isCompanyOff = paidLeaveFull || (!requestedOff && isCompanyOffAssignment(assignment));
                          const isConfigured = !isBlocked && !isCompanyOff && Boolean(
                            assignment?.shift_label && (
                              assignment.shift_label !== "自由入力" || assignment.start_time || assignment.end_time
                            ),
                          );
                          const requestClass = beforeHire
                            ? " shift-cell--blocked"
                            : requestedOff
                            ? " shift-cell--blocked"
                            : isCompanyOff
                            ? " shift-cell--company-off"
                            : request && !paidLeaveType
                            ? " shift-cell--requested"
                            : "";
                          return (
                            <td key={`${employee.user_id}:${date}`} className={`shift-cell shift-colorable-cell${requestClass}${isConfigured ? " shift-cell--configured" : ""}`} {...coloredCellProps(date, `user:${employee.user_id}`)}>
                              <ShiftCellColorPicker
                                currentColor={cellStyleMap.get(`${date}:user:${employee.user_id}`)}
                                disabled={shiftControlsDisabled}
                                label={`${formatDateShort(date)} ${displayName(employee)}のセル`}
                                onChange={(color) => setCellColorLocal(date, `user:${employee.user_id}`, color)}
                              />
                              {requestedOff && request && (
                                <span className="shift-request-badge" title={request.memo || REQUEST_LABELS[request.request_type]}>
                                  {REQUEST_LABELS[request.request_type]}
                                </span>
                              )}
                              {beforeHire && <span className="shift-request-badge">入社前</span>}
                              {isCompanyOff && <span className="shift-company-off-badge">会社休</span>}
                              <div className="shift-cell__controls">
                                <button
                                  type="button"
                                  className={`shift-request-toggle${requestedOff ? " shift-request-toggle--active" : ""}`}
                                  onClick={() => toggleAdminRequest(employee, date)}
                                  disabled={beforeHire || paidLeaveFull || shiftControlsDisabled}
                                  title={requestedOff ? "休み希望を解除" : "休み希望にする"}
                                >
                                  休
                                </button>
                                <select
                                  value={assignment?.shift_label || ""}
                                  onChange={(event) => {
                                    if (isBlocked) return;
                                    updateAssignmentLocal(employee, date, event.target.value);
                                  }}
                                  disabled={isBlocked || shiftControlsDisabled}
                                >
                                  <option value="">{beforeHire ? "入社前" : requestedOff ? "希望休" : isCompanyOff ? "会社休" : "未設定"}</option>
                                  {assignmentPatternOptions(employee, payload?.patterns || [], assignment?.shift_label).map((pattern) => (
                                    <option key={pattern.id} value={pattern.label}>{pattern.label}</option>
                                  ))}
                                </select>
                              </div>
                              <select
                                className="shift-paid-leave-select"
                                value={paidLeaveType}
                                onChange={(event) => setPaidLeaveRequestLocal(
                                  employee,
                                  date,
                                  event.target.value as "" | "paid_leave_full" | "paid_leave_half",
                                )}
                                disabled={beforeHire || shiftControlsDisabled}
                                aria-label={`${displayName(employee)} ${formatDateShort(date)}の有給設定`}
                              >
                                <option value="">有給なし</option>
                                <option value="paid_leave_full">全休</option>
                                <option value="paid_leave_half">半休</option>
                              </select>
                              <div className="shift-cell__secondary-actions">
                                <button
                                  type="button"
                                  className={`shift-company-off-toggle${isCompanyOff ? " shift-company-off-toggle--active" : ""}`}
                                  onClick={() => setCompanyOffLocal(employee, date)}
                                  disabled={isBlocked || isCompanyOff || shiftControlsDisabled}
                                  title={isCompanyOff ? "会社休です。勤務を選ぶと解除されます" : "会社指定の休みにする"}
                                >
                                  会社休
                                </button>
                                {selectedPeriod.department !== "製造" && (
                                  <button
                                    type="button"
                                    className="shift-time-toggle"
                                    onClick={() => toggleTimeEditor(employee, date)}
                                    disabled={isBlocked || shiftControlsDisabled}
                                    title="出勤・退勤を直接入力"
                                  >
                                    <Clock3 size={13} aria-hidden="true" />
                                    時刻入力
                                  </button>
                                )}
                              </div>
                              {renderAssignmentTimeEditor(employee, date, assignment, isBlocked || shiftControlsDisabled)}
                            </td>
                          );
                        })}
                        <td className={`shift-colorable-cell shift-timee-cell${selectedPeriod.department === "道の駅" ? " shift-timee-cell--details" : ""}`} {...coloredCellProps(date, "timee")}>
                          <ShiftCellColorPicker
                            currentColor={cellStyleMap.get(`${date}:timee`)}
                            disabled={shiftControlsDisabled}
                            label={`${formatDateShort(date)}のTimeeセル`}
                            onChange={(color) => setCellColorLocal(date, "timee", color)}
                          />
                          {selectedPeriod.department === "道の駅" ? (
                            <RoadStationTimeeEditor
                              requirement={requirement}
                              disabled={shiftControlsDisabled}
                              onChange={(value) => updateRequirementLocal(date, value)}
                            />
                          ) : (
                            <input
                              className="shift-count-input"
                              inputMode="decimal"
                              value={requirement.timee_count ?? ""}
                              onChange={(event) => updateRequirementLocal(date, { timee_count: event.target.value })}
                              disabled={shiftControlsDisabled}
                            />
                          )}
                        </td>
                        {selectedPeriod.department === "製造" ? (
                          <>
                            <td className="shift-note-cell shift-colorable-cell" {...coloredCellProps(date, "notes")}>
                              <ShiftCellColorPicker
                                currentColor={cellStyleMap.get(`${date}:notes`)}
                                disabled={shiftControlsDisabled}
                                label={`${formatDateShort(date)}の備考1セル`}
                                onChange={(color) => setCellColorLocal(date, "notes", color)}
                              />
                              <input
                                value={requirement.notes || ""}
                                onChange={(event) => updateRequirementLocal(date, { notes: event.target.value })}
                                disabled={confirmedNotesDisabled}
                                placeholder="備考1"
                              />
                            </td>
                            <td className="shift-note-cell shift-colorable-cell" {...coloredCellProps(date, "notes2")}>
                              <ShiftCellColorPicker
                                currentColor={cellStyleMap.get(`${date}:notes2`)}
                                disabled={shiftControlsDisabled}
                                label={`${formatDateShort(date)}の備考2セル`}
                                onChange={(color) => setCellColorLocal(date, "notes2", color)}
                              />
                              <input
                                value={manufacturingNote2Value(requirement)}
                                onChange={(event) => updateRequirementLocal(date, {
                                  notes2: event.target.value,
                                  production_plan: "",
                                })}
                                disabled={confirmedNotesDisabled}
                                placeholder="備考2"
                              />
                            </td>
                          </>
                        ) : (
                          <td className="shift-note-cell shift-colorable-cell" {...coloredCellProps(date, "notes")}>
                            <ShiftCellColorPicker
                              currentColor={cellStyleMap.get(`${date}:notes`)}
                              disabled={shiftControlsDisabled}
                              label={`${formatDateShort(date)}の備考セル`}
                              onChange={(color) => setCellColorLocal(date, "notes", color)}
                            />
                            {selectedPeriod.department === "フロア" && (
                              <ShiftEcSalePicker
                                options={payload?.saleOptions || []}
                                selected={requirement.ec_sale_tags || []}
                                times={requirement.ec_sale_times || {}}
                                disabled={shiftControlsDisabled}
                                onManage={() => setSaleManagerOpen(true)}
                                onChange={(next, nextTimes) => {
                                  updateRequirementLocal(date, { ec_sale_tags: next, ec_sale_times: nextTimes });
                                }}
                              />
                            )}
                            <input
                              value={selectedPeriod.department === "道の駅" ? requirement.notes || "" : requirement.notes2 || requirement.notes || ""}
                              onChange={(event) => updateRequirementLocal(
                                date,
                                selectedPeriod.department === "道の駅"
                                  ? { notes: event.target.value }
                                  : { notes: "", notes2: event.target.value },
                              )}
                              disabled={confirmedNotesDisabled}
                              placeholder="任意の備考を追加"
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="shift-mobile-list">
              {dates.map((date) => {
                const requirement = requirementMap.get(date) || emptyRequirement(selectedPeriod, date);
                return (
                  <article key={date} className="shift-day-card">
                    <div className="shift-day-card__header" {...coloredCellProps(date, "date")}>
                      <div className="shift-day-card__date">
                        <strong>{formatDateShort(date)}</strong>
                        <ShiftDateColorPicker
                          currentColor={cellStyleMap.get(`${date}:date`)}
                          disabled={shiftControlsDisabled}
                          label={`${formatDateShort(date)}の日付セル`}
                          onChange={(color) => setCellColorLocal(date, "date", color)}
                        />
                      </div>
                      <label>
                        必要
                        <input
                          inputMode="decimal"
                          value={requirement.required_count ?? ""}
                          onChange={(event) => updateRequirementLocal(date, { required_count: event.target.value })}
                          disabled={shiftControlsDisabled}
                        />
                      </label>
                    </div>

                    <div className="shift-day-card__meta">
                      <label>
                        場所
                        <input
                          value={requirement.workplace_label || ""}
                          onChange={(event) => updateRequirementLocal(date, { workplace_label: event.target.value })}
                          disabled={shiftControlsDisabled}
                        />
                      </label>
                      {selectedPeriod.department === "道の駅" ? (
                        <div className="shift-day-card__wide shift-day-card__field">
                          <span>Timee（内容・時刻）</span>
                          <RoadStationTimeeEditor
                            requirement={requirement}
                            disabled={shiftControlsDisabled}
                            onChange={(value) => updateRequirementLocal(date, value)}
                          />
                        </div>
                      ) : (
                        <label>
                          Timee
                          <input
                            inputMode="decimal"
                            value={requirement.timee_count ?? ""}
                            onChange={(event) => updateRequirementLocal(date, { timee_count: event.target.value })}
                            disabled={shiftControlsDisabled}
                          />
                        </label>
                      )}
                      {selectedPeriod.department === "製造" ? (
                        <>
                          <div className="shift-day-card__wide shift-day-card__field">
                            <span>備考1</span>
                            <input
                              value={requirement.notes || ""}
                              onChange={(event) => updateRequirementLocal(date, { notes: event.target.value })}
                              disabled={confirmedNotesDisabled}
                              placeholder="備考1"
                            />
                          </div>
                          <div className="shift-day-card__wide shift-day-card__field">
                            <span>備考2</span>
                            <input
                              value={manufacturingNote2Value(requirement)}
                              onChange={(event) => updateRequirementLocal(date, {
                                notes2: event.target.value,
                                production_plan: "",
                              })}
                              disabled={confirmedNotesDisabled}
                              placeholder="備考2"
                            />
                          </div>
                        </>
                      ) : (
                        <div className="shift-day-card__wide shift-day-card__field">
                          <span>{selectedPeriod.department === "道の駅" ? "備考" : "ECセール / 備考2"}</span>
                          {selectedPeriod.department === "フロア" && (
                            <ShiftEcSalePicker
                              options={payload?.saleOptions || []}
                              selected={requirement.ec_sale_tags || []}
                              times={requirement.ec_sale_times || {}}
                              disabled={shiftControlsDisabled}
                              onManage={() => setSaleManagerOpen(true)}
                              onChange={(next, nextTimes) => {
                                updateRequirementLocal(date, { ec_sale_tags: next, ec_sale_times: nextTimes });
                              }}
                            />
                          )}
                          <input
                            value={selectedPeriod.department === "道の駅" ? requirement.notes || "" : requirement.notes2 || requirement.notes || ""}
                            onChange={(event) => updateRequirementLocal(
                              date,
                              selectedPeriod.department === "道の駅"
                                ? { notes: event.target.value }
                                : { notes: "", notes2: event.target.value },
                            )}
                            disabled={confirmedNotesDisabled}
                            placeholder="任意の備考を追加"
                          />
                        </div>
                      )}
                    </div>

                    <div className="shift-day-staff">
                      {payload?.employees.map((employee) => {
                        const assignment = assignmentMap.get(`${employee.user_id}:${date}`);
                        const request = requestMap.get(`${employee.user_id}:${date}`);
                        const beforeHire = isBeforeHireDate(employee, date);
                        const requestedOff = request?.request_type === "day_off" || request?.request_type === "unavailable";
                        const paidLeaveFull = request?.request_type === "paid_leave_full";
                        const paidLeaveType = request?.request_type === "paid_leave_full" || request?.request_type === "paid_leave_half"
                          ? request.request_type
                          : "";
                        const isBlocked = beforeHire || requestedOff || paidLeaveFull;
                        const isCompanyOff = paidLeaveFull || (!requestedOff && isCompanyOffAssignment(assignment));
                        const isConfigured = !isBlocked && !isCompanyOff && Boolean(
                          assignment?.shift_label && (
                            assignment.shift_label !== "自由入力" || assignment.start_time || assignment.end_time
                          ),
                        );
                        return (
                          <div
                            key={`${employee.user_id}:${date}:mobile`}
                            className={`shift-day-staff__row${beforeHire || requestedOff ? " shift-day-staff__row--blocked" : ""}${isCompanyOff ? " shift-day-staff__row--company-off" : ""}${isConfigured ? " shift-day-staff__row--configured" : ""}`}
                            {...coloredCellProps(date, `user:${employee.user_id}`)}
                          >
                            <span>
                              <strong>{displayName(employee)}</strong>
                              <small>{employee.employee_code || "NO未設定"} / {workStyleLabel(employee.work_style)}</small>
                              {effectiveTargetUserIds.has(employee.user_id) && (
                                <em>{submittedUserIds.has(employee.user_id) ? "希望回収済み" : "未提出"}</em>
                              )}
                              {requestedOff && request && (
                                <em title={request.memo || REQUEST_LABELS[request.request_type]}>
                                  希望: {REQUEST_LABELS[request.request_type]}
                                </em>
                              )}
                              {beforeHire && <em>入社日前</em>}
                              {isCompanyOff && <em className="shift-company-off-text">会社指定の休み</em>}
                            </span>
                            <div className="shift-day-staff__controls">
                              <button
                                type="button"
                                className={`shift-request-toggle${requestedOff ? " shift-request-toggle--active" : ""}`}
                                onClick={() => toggleAdminRequest(employee, date)}
                                disabled={beforeHire || paidLeaveFull || shiftControlsDisabled}
                              >
                                休
                              </button>
                              <select
                                value={assignment?.shift_label || ""}
                                onChange={(event) => {
                                  if (isBlocked) return;
                                  updateAssignmentLocal(employee, date, event.target.value);
                                }}
                                disabled={isBlocked || shiftControlsDisabled}
                              >
                                <option value="">{beforeHire ? "入社前" : requestedOff ? "希望休" : isCompanyOff ? "会社休" : "未設定"}</option>
                                {assignmentPatternOptions(employee, payload?.patterns || [], assignment?.shift_label).map((pattern) => (
                                  <option key={pattern.id} value={pattern.label}>{pattern.label}</option>
                                ))}
                              </select>
                            </div>
                            <select
                              className="shift-paid-leave-select"
                              value={paidLeaveType}
                              onChange={(event) => setPaidLeaveRequestLocal(
                                employee,
                                date,
                                event.target.value as "" | "paid_leave_full" | "paid_leave_half",
                              )}
                              disabled={beforeHire || shiftControlsDisabled}
                              aria-label={`${displayName(employee)} ${formatDateShort(date)}の有給設定`}
                            >
                              <option value="">有給なし</option>
                              <option value="paid_leave_full">全休</option>
                              <option value="paid_leave_half">半休</option>
                            </select>
                            <div className="shift-cell__secondary-actions">
                              <button
                                type="button"
                                className={`shift-company-off-toggle${isCompanyOff ? " shift-company-off-toggle--active" : ""}`}
                                onClick={() => setCompanyOffLocal(employee, date)}
                                disabled={isBlocked || isCompanyOff || shiftControlsDisabled}
                              >
                                会社休
                              </button>
                              {selectedPeriod.department !== "製造" && (
                                <button
                                  type="button"
                                  className="shift-time-toggle"
                                  onClick={() => toggleTimeEditor(employee, date)}
                                  disabled={isBlocked || shiftControlsDisabled}
                                >
                                  <Clock3 size={14} aria-hidden="true" />
                                  出勤・退勤を入力
                                </button>
                              )}
                            </div>
                            {renderAssignmentTimeEditor(employee, date, assignment, isBlocked || shiftControlsDisabled)}
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="shift-admin__panel">
            <h3>希望一覧</h3>
            <div className="shift-submission-list">
              {(payload?.employees || []).filter((employee) => !employee.request_collection_excluded).map((employee) => ({
                  userId: employee.user_id,
                  name: displayName(employee),
                  workStyle: employee.work_style,
                })).map((person) => {
                const submission = submissionByUserId.get(person.userId);
                const constraints = resolveShiftConstraints(person.workStyle, dates.length, {
                  maxWorkDays: submission?.max_work_days,
                  targetWorkDays: submission?.target_work_days,
                  minDaysOff: submission?.min_days_off,
                  maxConsecutiveDays: submission?.max_consecutive_days,
                });
                return (
                  <span key={person.userId} className={submittedUserIds.has(person.userId) ? "shift-submission-list__item shift-submission-list__item--done" : "shift-submission-list__item"}>
                    {person.name}
                    <small>{submission?.is_test ? "テスト希望" : submittedUserIds.has(person.userId) ? "希望回収済み" : "未提出"}</small>
                    {submission && (
                      <em>希望{constraints.targetWorkDays}日 / 上限{constraints.effectiveMaxWorkDays}日 / 最低休日{constraints.minDaysOff}日 / 最大{constraints.maxConsecutiveDays}連勤</em>
                    )}
                    {submission?.request_comment && <em>{submission.request_comment}</em>}
                  </span>
                );
              })}
            </div>
            {(payload?.requestSubmissions || []).some((submission) => submission.request_comment) && (
              <div className="shift-request-list shift-request-list--comments">
                {(payload?.requestSubmissions || [])
                  .filter((submission) => submission.request_comment)
                  .map((submission) => {
                    const employee = payload?.employees.find((item) => item.user_id === submission.user_id);
                    return (
                      <div key={`comment-${submission.id}`} className="shift-request-item">
                        <strong>{employee ? displayName(employee) : "不明"} その他の要望</strong>
                        <p>{submission.request_comment}</p>
                      </div>
                    );
                  })}
              </div>
            )}
            <div className="shift-request-list">
              {(payload?.requests || []).length === 0 && <p>提出された希望はありません。</p>}
              {(payload?.requests || []).map((request) => {
                const employee = payload?.employees.find((item) => item.user_id === request.user_id);
                return (
                  <div key={request.id} className="shift-request-item">
                    <strong>{request.work_date} {employee ? displayName(employee) : "不明"}</strong>
                    <span>{REQUEST_LABELS[request.request_type]} / {request.priority}</span>
                    {(request.start_time || request.end_time) && <span>{request.start_time || "--:--"}〜{request.end_time || "--:--"}</span>}
                    {request.memo && <p>{request.memo}</p>}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
