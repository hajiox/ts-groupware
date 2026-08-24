"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { countsTowardDepartmentHeadcount } from "@/lib/shift-assignments";
import { shiftEcSaleDisplayLabel, type ShiftEcSaleOption, type ShiftEcSaleTimes } from "@/lib/shift-sales";
import { shiftTimeeDisplay, shiftTimeeHeadcount } from "@/lib/shift-timee";

type ShiftPeriod = {
  id: string;
  department: string;
  title: string;
  start_date: string;
  end_date: string;
};

type ShiftEmployee = {
  id: string;
  user_id: string;
  employee_code: string | null;
  display_name: string;
  real_name: string | null;
  work_style: string | null;
};

type ShiftRequirement = {
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

type ShiftAssignment = {
  user_id: string | null;
  work_date: string;
  shift_label: string | null;
  note: string | null;
};

type ShiftRequest = {
  user_id: string;
  work_date: string;
  request_type: string;
};

type ShiftHoliday = {
  holiday_date: string;
  name: string;
  holiday_type: string;
};

type ShiftCellStyle = {
  work_date: string;
  cell_key: string;
  background_color: string | null;
};

type ShiftPrintPayload = {
  selectedPeriod: ShiftPeriod | null;
  employees: ShiftEmployee[];
  requirements: ShiftRequirement[];
  assignments: ShiftAssignment[];
  requests: ShiftRequest[];
  holidays: ShiftHoliday[];
  saleOptions: ShiftEcSaleOption[];
  cellStyles: ShiftCellStyle[];
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function isDarkCellColor(color: string | null | undefined) {
  const hex = color?.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 < 145;
}
function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result.length > 0 ? result : [[]];
}

function balancedChunks<T>(items: T[], maxSize: number) {
  if (items.length === 0) return [[]];
  const pageCount = Math.ceil(items.length / maxSize);
  const baseSize = Math.floor(items.length / pageCount);
  const extraPages = items.length % pageCount;
  const result: T[][] = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageSize = baseSize + (pageIndex < extraPages ? 1 : 0);
    result.push(items.slice(offset, offset + pageSize));
    offset += pageSize;
  }
  return result;
}

function manufacturingNote2Value(requirement?: ShiftRequirement) {
  return [...new Set(
    [requirement?.notes2, requirement?.production_plan]
      .map((value) => value?.trim() || "")
      .filter(Boolean),
  )].join(" / ");
}

function displayName(employee: ShiftEmployee) {
  return employee.real_name || employee.display_name;
}

function employeeHeaderClass(employee: ShiftEmployee) {
  if (employee.work_style === "regular_5d_8h" || employee.work_style === "regular_6d_6_5h") {
    return "shift-print-employee-head shift-print-employee-head--regular";
  }
  if (employee.work_style === "part_time_under_29_5h" || employee.work_style === "full_time_part") {
    return "shift-print-employee-head shift-print-employee-head--part";
  }
  return "shift-print-employee-head";
}

function compactName(value: string) {
  return value.replace(/[\s\u3000]/g, "");
}

function weekday(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 15)).getUTCDay()] || "";
}

function dateLabel(dateText: string) {
  return `${Number(dateText.slice(5, 7))}/${Number(dateText.slice(8, 10))}`;
}

function defaultWorkplace(department: string) {
  if (department === "フロア") return "会津ブランド館";
  if (department === "製造") return "本社製造";
  return "道の駅会津";
}

export default function ShiftPrintPage() {
  const [payload, setPayload] = useState<ShiftPrintPayload | null>(null);
  const [message, setMessage] = useState("読み込み中...");

  useEffect(() => {
    const periodId = new URLSearchParams(window.location.search).get("period_id") || "";
    if (!periodId) {
      setMessage("印刷するシフト期間が指定されていません");
      return;
    }
    fetch(`/api/admin/shifts?period_id=${encodeURIComponent(periodId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "シフトを読み込めませんでした");
        setPayload(data);
        setMessage("");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "シフトを読み込めませんでした"));
  }, []);

  const printPages = useMemo(() => {
    const period = payload?.selectedPeriod;
    if (!period) return [];
    const datePages = chunks(eachDate(period.start_date, period.end_date), 16);
    const employeePages = balancedChunks(payload?.employees || [], 7);
    return datePages.flatMap((dates, datePageIndex) => employeePages.map((employees, employeePageIndex) => ({
      dates,
      employees,
      datePageIndex,
      employeePageIndex,
      datePageCount: datePages.length,
      employeePageCount: employeePages.length,
    })));
  }, [payload]);

  const assignmentMap = useMemo(() => new Map(
    (payload?.assignments || [])
      .filter((assignment) => assignment.user_id)
      .map((assignment) => [`${assignment.user_id}:${assignment.work_date}`, assignment]),
  ), [payload?.assignments]);
  const requestMap = useMemo(() => new Map(
    (payload?.requests || []).map((request) => [`${request.user_id}:${request.work_date}`, request]),
  ), [payload?.requests]);
  const paidLeaveFullKeys = useMemo(() => new Set(
    (payload?.requests || [])
      .filter((request) => request.request_type === "paid_leave_full")
      .map((request) => `${request.user_id}:${request.work_date}`),
  ), [payload?.requests]);
  const requirementMap = useMemo(() => new Map(
    (payload?.requirements || []).map((requirement) => [requirement.work_date, requirement]),
  ), [payload?.requirements]);
  const assignedCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    const department = payload?.selectedPeriod?.department || "";
    for (const assignment of payload?.assignments || []) {
      if (!countsTowardDepartmentHeadcount(department, assignment)) continue;
      if (paidLeaveFullKeys.has(`${assignment.user_id}:${assignment.work_date}`)) continue;
      map.set(assignment.work_date, (map.get(assignment.work_date) || 0) + 1);
    }
    return map;
  }, [paidLeaveFullKeys, payload?.assignments, payload?.selectedPeriod?.department]);
  const holidayMap = useMemo(() => new Map(
    (payload?.holidays || []).map((holiday) => [holiday.holiday_date, holiday]),
  ), [payload?.holidays]);
  const saleById = useMemo(() => new Map(
    (payload?.saleOptions || []).map((option) => [option.id, option]),
  ), [payload?.saleOptions]);
  const cellStyleMap = useMemo(() => new Map(
    (payload?.cellStyles || []).map((style) => [`${style.work_date}:${style.cell_key}`, style.background_color]),
  ), [payload?.cellStyles]);
  const printCellStyle = (date: string, cellKey: string) => {
    const backgroundColor = cellStyleMap.get(`${date}:${cellKey}`) || undefined;
    return backgroundColor ? { backgroundColor, ...(isDarkCellColor(backgroundColor) ? { color: "#ffffff" } : {}) } : undefined;
  };
  const floorCountExcludedEmployee = useMemo(() => (
    (payload?.employees || []).find((employee) => compactName(displayName(employee)) === "藤田香織") || null
  ), [payload?.employees]);

  return (
    <main className="shift-print-preview">
      <header className="shift-print-toolbar">
        <button
          type="button"
          className="admin-btn-outline"
          onClick={() => {
            window.close();
            window.setTimeout(() => { window.location.href = "/admin"; }, 150);
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          閉じる
        </button>
        <div>
          <strong>シフト印刷プレビュー</strong>
          <span>{payload?.selectedPeriod?.title || ""}</span>
        </div>
        <button type="button" className="btn-primary" onClick={() => window.print()} disabled={!payload?.selectedPeriod}>
          <Printer size={17} aria-hidden="true" />
          印刷
        </button>
      </header>

      {message && <div className="shift-print-message">{message}</div>}

      <div className="shift-print-pages">
        {printPages.map((page, pageIndex) => {
          const period = payload!.selectedPeriod!;
          const workplace = requirementMap.get(page.dates[0])?.workplace_label || defaultWorkplace(period.department);
          return (
            <section
              key={`${page.datePageIndex}:${page.employeePageIndex}`}
              className={`shift-print-sheet${period.department === "製造" ? " shift-print-sheet--manufacturing" : ""}`}
            >
              <div className="shift-print-sheet__heading">
                <div>
                  <strong>{period.title}</strong>
                  <span>{page.dates[0]}〜{page.dates[page.dates.length - 1]}</span>
                </div>
                <small>{period.department} / {pageIndex + 1}ページ</small>
              </div>

              <table className="shift-print-table">
                <thead>
                  <tr>
                    <th rowSpan={2} className="shift-print-date-head">日付</th>
                    <th rowSpan={2} className="shift-print-weekday-head">曜日</th>
                    {page.employees.map((employee) => (
                      <th key={employee.user_id} className={employeeHeaderClass(employee)}>{displayName(employee)}</th>
                    ))}
                    <th rowSpan={2} className="shift-print-count-head">{period.department}<br />人数</th>
                    <th rowSpan={2} className="shift-print-note-head">{period.department}{period.department === "製造" ? "備考1" : "備考"}</th>
                    <th rowSpan={2} className="shift-print-note2-head">{period.department}備考2</th>
                  </tr>
                  <tr>
                    <th colSpan={Math.max(1, page.employees.length)} className="shift-print-workplace">{workplace}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.dates.map((date) => {
                    const requirement = requirementMap.get(date);
                    const day = weekday(date);
                    const assignedCount = assignedCountByDate.get(date) || 0;
                    const excludedEmployeeWorks = period.department === "フロア" && floorCountExcludedEmployee
                      ? Boolean(assignmentMap.get(`${floorCountExcludedEmployee.user_id}:${date}`)?.shift_label)
                      : false;
                    const timeeCount = period.department === "道の駅"
                      ? shiftTimeeHeadcount(requirement?.notes2, requirement?.notes3, requirement?.timee_count)
                      : 0;
                    const displayedCount = Math.max(0, assignedCount - (excludedEmployeeWorks ? 1 : 0)) + timeeCount;
                    const holiday = holidayMap.get(date);
                    const isRedDay = day === "日" || Boolean(holiday);
                    const timeeText = period.department === "道の駅"
                      ? shiftTimeeDisplay(requirement?.notes2, requirement?.notes3, requirement?.timee_count)
                      : "";
                    const freeNote = period.department === "道の駅"
                      ? requirement?.notes
                      : period.department === "製造"
                        ? requirement?.notes
                        : requirement?.notes2 || requirement?.notes;
                    const secondaryNotes = period.department === "道の駅"
                      ? [timeeText ? `Timee: ${timeeText}` : "", requirement?.production_plan].filter(Boolean).join(" / ")
                      : period.department === "製造"
                        ? manufacturingNote2Value(requirement)
                        : [freeNote, requirement?.notes3, requirement?.production_plan].filter(Boolean).join(" / ");
                    return (
                      <tr key={date}>
                        <td className={`shift-print-date${isRedDay ? " shift-print-date--holiday" : ""}`} style={printCellStyle(date, "date")} title={holiday?.name || undefined}>{dateLabel(date)}</td>
                        <td className={`shift-print-weekday shift-print-weekday--${isRedDay ? "holiday" : day === "土" ? "sat" : "weekday"}`} style={printCellStyle(date, "date")} title={holiday?.name || undefined}>{day}</td>
                        {page.employees.map((employee) => {
                          const assignment = assignmentMap.get(`${employee.user_id}:${date}`);
                          const request = requestMap.get(`${employee.user_id}:${date}`);
                          const requestedOff = request?.request_type === "day_off" || request?.request_type === "unavailable";
                          const paidLeaveFull = request?.request_type === "paid_leave_full";
                          return (
                            <td
                              key={`${employee.user_id}:${date}`}
                              className={requestedOff ? "shift-print-cell--requested-off" : paidLeaveFull ? "shift-print-cell--company-off" : assignment?.shift_label ? "shift-print-cell--working" : "shift-print-cell--company-off"}
                              style={printCellStyle(date, `user:${employee.user_id}`)}
                            >
                              {requestedOff || paidLeaveFull ? "" : assignment?.shift_label || ""}
                            </td>
                          );
                        })}
                        <td className="shift-print-count" style={printCellStyle(date, "required")}>{displayedCount}</td>
                        <td className="shift-print-notes" style={printCellStyle(date, "notes")}>
                          {period.department === "フロア" && (requirement?.ec_sale_tags || []).map((saleId) => {
                            const sale = saleById.get(saleId);
                            const occurrenceTime = requirement?.ec_sale_times?.[saleId] || { start_time: null, end_time: null };
                            return sale ? <span key={sale.id} className={`shift-print-sale shift-print-sale--${sale.color}`}>{shiftEcSaleDisplayLabel({ label: sale.label, ...occurrenceTime })}</span> : null;
                          })}
                          {(period.department === "道の駅" || period.department === "製造") && freeNote && <span className="shift-print-free-note">{freeNote}</span>}
                        </td>
                        <td className="shift-print-notes2" style={printCellStyle(date, "notes2")}>{secondaryNotes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {period.department === "フロア" && (
                <footer className="shift-print-legend">
                  <span style={{ background: "#75e6e5", color: "#0f172a" }}>勤務時間希望</span>
                  <span style={{ background: "#ffe699", color: "#0f172a" }}>物販対応</span>
                  <span style={{ background: "#f4b7b2", color: "#0f172a" }}>レクチャー</span>
                  <span style={{ background: "#f4b183", color: "#0f172a" }}>猪苗代納品日</span>
                  <span style={{ background: "#8ea9db", color: "#0f172a" }}>伝票出し</span>
                  <span style={{ background: "#c6e0b4", color: "#0f172a" }}>シフト調整してくれた方</span>
                  <span style={{ background: "#111827", color: "#ffffff" }}>会社付与休日</span>
                  <span style={{ background: "#fff2cc", color: "#0f172a" }}>火・土 物販対応設定日</span>
                </footer>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
