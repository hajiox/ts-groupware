"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Building2 } from "lucide-react";
import { countsTowardDepartmentHeadcount, isCompanyOffAssignment } from "@/lib/shift-assignments";
import { shiftTimeeDisplay, shiftTimeeHeadcount } from "@/lib/shift-timee";

type ConfirmedPeriod = {
  id: string;
  department: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  confirmed_at: string | null;
};

type ConfirmedAssignment = {
  id: string;
  period_id: string;
  user_id: string | null;
  employee_id: string | null;
  work_date: string;
  shift_label: string | null;
  start_time: string | null;
  end_time: string | null;
  assignment_type: string;
  note: string | null;
  employee_name: string;
  employee_code: string | null;
  sort_order: number;
};

type ConfirmedRequirement = {
  id: string;
  period_id: string;
  work_date: string;
  required_count: number | string | null;
  workplace_label: string | null;
  notes: string | null;
  notes2: string | null;
  notes3: string | null;
  production_plan: string | null;
  timee_count: number | string | null;
  ec_sale_labels: string[];
};

type ConfirmedRequest = {
  period_id: string;
  user_id: string;
  employee_id: string | null;
  work_date: string;
  request_type: string;
};

type ConfirmedCellStyle = {
  period_id: string;
  work_date: string;
  cell_key: string;
  background_color: string | null;
};

type ConfirmedHoliday = {
  holiday_date: string;
  name: string;
  holiday_type: string;
};

export type ConfirmedShiftPayload = {
  today: string;
  userId: string;
  homeDepartment: string;
  periods: ConfirmedPeriod[];
  assignments: ConfirmedAssignment[];
  requirements: ConfirmedRequirement[];
  requests: ConfirmedRequest[];
  cellStyles: ConfirmedCellStyle[];
  holidays: ConfirmedHoliday[];
};

const DEPARTMENTS = ["フロア", "製造", "道の駅"];
const REQUESTED_OFF_TYPES = new Set(["day_off", "unavailable", "paid_leave_full", "paid_leave_half"]);

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function weekday(dateText: string) {
  const labels = ["日", "月", "火", "水", "木", "金", "土"];
  const [year, month, day] = dateText.split("-").map(Number);
  return labels[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

function timeText(start: string | null, end: string | null) {
  const normalizedStart = start?.slice(0, 5) || "";
  const normalizedEnd = end?.slice(0, 5) || "";
  if (normalizedStart && normalizedEnd) return `${normalizedStart}〜${normalizedEnd}`;
  if (normalizedStart) return `${normalizedStart}〜`;
  if (normalizedEnd) return `〜${normalizedEnd}`;
  return "";
}

function staffKey(value: Pick<ConfirmedAssignment, "user_id" | "employee_id" | "employee_name">) {
  return value.user_id || value.employee_id || value.employee_name;
}

function requestStaffKey(value: Pick<ConfirmedRequest, "user_id" | "employee_id">) {
  return value.user_id || value.employee_id || "";
}

function defaultWorkplace(department: string) {
  if (department === "フロア") return "会津ブランド館";
  if (department === "製造") return "本社製造";
  return "道の駅会津";
}

function isDarkCellColor(color: string | null | undefined) {
  const hex = color?.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 < 145;
}

function preferredPeriod(periods: ConfirmedPeriod[], today: string) {
  return periods.find((period) => period.start_date <= today && period.end_date >= today)
    || [...periods].filter((period) => period.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0]
    || [...periods].sort((a, b) => b.start_date.localeCompare(a.start_date))[0]
    || null;
}

export function ConfirmedShiftView({
  payload,
  loading,
  error,
}: {
  payload: ConfirmedShiftPayload | null;
  loading: boolean;
  error: string;
}) {
  const orderedDepartments = useMemo(() => {
    const own = payload?.homeDepartment || "";
    return [...DEPARTMENTS].sort((left, right) => {
      if (left === own) return -1;
      if (right === own) return 1;
      return DEPARTMENTS.indexOf(left) - DEPARTMENTS.indexOf(right);
    });
  }, [payload?.homeDepartment]);
  const [department, setDepartment] = useState("");
  const [periodId, setPeriodId] = useState("");

  useEffect(() => {
    if (!payload) return;
    const nextDepartment = DEPARTMENTS.includes(payload.homeDepartment)
      ? payload.homeDepartment
      : DEPARTMENTS[0];
    setDepartment((current) => DEPARTMENTS.includes(current) ? current : nextDepartment);
  }, [payload]);

  const departmentPeriods = useMemo(
    () => (payload?.periods || []).filter((period) => period.department === department),
    [department, payload?.periods],
  );

  useEffect(() => {
    if (!payload) return;
    const selectedExists = departmentPeriods.some((period) => period.id === periodId);
    if (!selectedExists) setPeriodId(preferredPeriod(departmentPeriods, payload.today)?.id || "");
  }, [departmentPeriods, payload, periodId]);

  const selectedPeriod = departmentPeriods.find((period) => period.id === periodId)
    || preferredPeriod(departmentPeriods, payload?.today || "")
    || null;
  const dates = selectedPeriod ? eachDate(selectedPeriod.start_date, selectedPeriod.end_date) : [];
  const periodAssignments: ConfirmedAssignment[] = [];
  for (const assignment of payload?.assignments || []) {
    if (assignment.period_id === selectedPeriod?.id && assignment.assignment_type !== "timee") periodAssignments.push(assignment);
  }
  const staffByKey = new Map<string, ConfirmedAssignment>();
  for (const assignment of periodAssignments) {
    const key = staffKey(assignment);
    const current = staffByKey.get(key);
    if (!current || assignment.sort_order < current.sort_order) staffByKey.set(key, assignment);
  }
  const staff = [...staffByKey.values()]
    .sort((left, right) => left.sort_order - right.sort_order || left.employee_name.localeCompare(right.employee_name, "ja"));
  const assignmentMap = new Map(periodAssignments.map((assignment) => [
    `${assignment.work_date}:${staffKey(assignment)}`,
    assignment,
  ]));
  const requirementByDate = new Map(
    (payload?.requirements || [])
      .filter((requirement) => requirement.period_id === selectedPeriod?.id)
      .map((requirement) => [requirement.work_date, requirement]),
  );
  const requestMap = new Map(
    (payload?.requests || [])
      .filter((request) => request.period_id === selectedPeriod?.id && REQUESTED_OFF_TYPES.has(request.request_type))
      .map((request) => [`${request.work_date}:${requestStaffKey(request)}`, request]),
  );
  const cellStyleMap = new Map(
    (payload?.cellStyles || [])
      .filter((style) => style.period_id === selectedPeriod?.id)
      .map((style) => [`${style.work_date}:${style.cell_key}`, style.background_color]),
  );
  const holidayMap = new Map((payload?.holidays || []).map((holiday) => [holiday.holiday_date, holiday]));
  const coloredCellProps = (date: string, key: string) => {
    const backgroundColor = cellStyleMap.get(`${date}:${key}`) || undefined;
    const foregroundColor = isDarkCellColor(backgroundColor) ? "#ffffff" : "#0f172a";
    return {
      style: backgroundColor ? {
        "--confirmed-shift-cell-background": backgroundColor,
        "--confirmed-shift-cell-foreground": foregroundColor,
        backgroundColor,
        color: foregroundColor,
      } as CSSProperties : undefined,
      "data-shift-cell-colored": backgroundColor ? "true" : undefined,
    };
  };

  if (loading) return <section className="shift-page__empty">確定シフトを読み込み中...</section>;
  if (error) return <div className="admin-message">{error}</div>;
  if (!payload?.periods.length) {
    return <section className="shift-page__empty">現在、確定保存済みのシフトはありません。</section>;
  }

  return (
    <section className="confirmed-shift">
      <div className="confirmed-shift__heading">
        <div>
          <span>公開済み</span>
          <h2>確定シフト</h2>
        </div>
        {selectedPeriod && (
          <strong>{selectedPeriod.start_date.replaceAll("-", "/")}〜{selectedPeriod.end_date.replaceAll("-", "/")}</strong>
        )}
      </div>

      <div className="confirmed-shift__departments" role="tablist" aria-label="所属を切り替える">
        {orderedDepartments.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={department === item}
            className={department === item ? "active" : ""}
            key={item}
            onClick={() => setDepartment(item)}
          >
            {item}
            {item === payload.homeDepartment && <small>所属</small>}
          </button>
        ))}
      </div>

      {departmentPeriods.length > 1 && (
        <label className="confirmed-shift__period">
          <span>表示期間</span>
          <select value={selectedPeriod?.id || ""} onChange={(event) => setPeriodId(event.target.value)}>
            {departmentPeriods.map((period) => (
              <option value={period.id} key={period.id}>
                {period.start_date.replaceAll("-", "/")}〜{period.end_date.replaceAll("-", "/")}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="confirmed-shift__table-area">
        {!selectedPeriod && (
          <div className="shift-page__empty">
            <Building2 size={18} />
            {department}の確定保存済みシフトはありません。
          </div>
        )}
        {selectedPeriod && (
          <>
            <div className="confirmed-shift__legend" aria-label="シフト表の色">
              <span className="confirmed-shift__legend-self">自分</span>
              <span className="confirmed-shift__legend-request">希望休</span>
              <span className="confirmed-shift__legend-off">会社休</span>
            </div>
            <div className="confirmed-shift-table-scroll" role="region" aria-label={`${department}の確定シフト表`} tabIndex={0}>
              <table
                className="confirmed-shift-table"
                style={{ minWidth: `${Math.max(920, 360 + staff.length * 116)}px` }}
              >
                <thead>
                  <tr>
                    <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__date">日付</th>
                    <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__weekday">曜</th>
                    {staff.map((employee) => (
                      <th
                        key={staffKey(employee)}
                        className={employee.user_id === payload.userId ? "confirmed-shift-table__self-head" : ""}
                      >
                        {employee.employee_name}
                        {employee.user_id === payload.userId && <small>自分</small>}
                      </th>
                    ))}
                    <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__count">{department}<br />人数</th>
                    {department === "道の駅" ? (
                      <>
                        <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__timee">Timee</th>
                        <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__notes">備考</th>
                      </>
                    ) : (
                      <>
                        <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__notes">備考</th>
                        <th rowSpan={staff.length ? 2 : 1} className="confirmed-shift-table__notes">その他</th>
                      </>
                    )}
                  </tr>
                  {staff.length > 0 && (
                    <tr>
                      <th colSpan={staff.length} className="confirmed-shift-table__workplace">
                        {requirementByDate.get(dates[0])?.workplace_label || defaultWorkplace(department)}
                      </th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {dates.map((date) => {
                    const requirement = requirementByDate.get(date);
                    const holiday = holidayMap.get(date);
                    const day = weekday(date);
                    const redDay = day === "日" || Boolean(holiday);
                    const staffWorkingCount = staff.filter((employee) => {
                      const key = `${date}:${staffKey(employee)}`;
                      const request = requestMap.get(key);
                      if (request?.request_type === "paid_leave_full") return false;
                      return countsTowardDepartmentHeadcount(department, assignmentMap.get(key));
                    }).length;
                    const requiredCount = Number(requirement?.required_count || 0);
                    const timee = shiftTimeeDisplay(requirement?.notes2, requirement?.notes3, requirement?.timee_count);
                    const workingCount = staffWorkingCount + (department === "道の駅"
                      ? shiftTimeeHeadcount(requirement?.notes2, requirement?.notes3, requirement?.timee_count)
                      : 0);
                    const primaryNotes = [...(requirement?.ec_sale_labels || []), requirement?.notes].filter(Boolean).join(" / ");
                    const otherNotes = [requirement?.production_plan, department === "道の駅" ? "" : requirement?.notes2, department === "道の駅" ? "" : requirement?.notes3]
                      .filter(Boolean)
                      .join(" / ");
                    return (
                      <tr className={date === payload.today ? "confirmed-shift-table__today" : ""} key={date}>
                        <td className={`confirmed-shift-table__date${redDay ? " confirmed-shift-table__red-day" : ""}`} {...coloredCellProps(date, "date")} title={holiday?.name}>
                          {date.slice(5).replace("-", "/")}
                        </td>
                        <td className={`confirmed-shift-table__weekday${redDay ? " confirmed-shift-table__red-day" : day === "土" ? " confirmed-shift-table__sat" : ""}`} {...coloredCellProps(date, "date")}>
                          {day}
                        </td>
                        {staff.map((employee) => {
                          const key = staffKey(employee);
                          const assignment = assignmentMap.get(`${date}:${key}`);
                          const request = requestMap.get(`${date}:${key}`);
                          const requestedOff = request?.request_type === "day_off" || request?.request_type === "unavailable";
                          const paidLeaveFull = request?.request_type === "paid_leave_full";
                          const companyOff = paidLeaveFull || isCompanyOffAssignment(assignment);
                          const label = requestedOff
                            ? "希望休"
                            : companyOff ? "休" : assignment?.shift_label || (assignment?.note && !assignment.note.startsWith("__") ? assignment.note : "");
                          const time = assignment ? timeText(assignment.start_time, assignment.end_time) : "";
                          return (
                            <td
                              key={`${date}:${key}`}
                              className={`${requestedOff ? "confirmed-shift-table__requested" : companyOff ? "confirmed-shift-table__off" : assignment?.shift_label ? "confirmed-shift-table__working" : ""}${employee.user_id === payload.userId ? " confirmed-shift-table__self" : ""}`}
                              {...coloredCellProps(date, `user:${employee.user_id || employee.employee_id}`)}
                              title={[employee.employee_name, label, time].filter(Boolean).join(" / ")}
                            >
                              {label}
                            </td>
                          );
                        })}
                        <td
                          className={`confirmed-shift-table__count${requiredCount > 0 && workingCount < requiredCount ? " confirmed-shift-table__short" : ""}`}
                          {...coloredCellProps(date, "required")}
                        >
                          {workingCount}
                          {requiredCount > 0 && <small>必要{requiredCount}</small>}
                        </td>
                        {department === "道の駅" ? (
                          <>
                            <td className="confirmed-shift-table__timee" {...coloredCellProps(date, "timee")}>{timee}</td>
                            <td className="confirmed-shift-table__notes" {...coloredCellProps(date, "notes")}>{[primaryNotes, otherNotes].filter(Boolean).join(" / ")}</td>
                          </>
                        ) : (
                          <>
                            <td className="confirmed-shift-table__notes" {...coloredCellProps(date, "notes")}>{primaryNotes}</td>
                            <td className="confirmed-shift-table__notes" {...coloredCellProps(date, "notes2")}>{otherNotes}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {selectedPeriod && dates.length === 0 && (
        <div className="shift-page__empty"><Building2 size={18} />表示できる日付がありません。</div>
      )}
    </section>
  );
}
