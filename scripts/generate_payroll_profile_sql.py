from __future__ import annotations

import argparse
import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from infer_payroll_profiles import parse_month


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_json(value: Any) -> str:
    return sql_literal(json.dumps(value or {}, ensure_ascii=False)) + "::jsonb"


def normalize_name(value: str | None) -> str:
    return re.sub(r"[\s\u3000]+", "", value or "")


def parse_month_name(name: str) -> str | None:
    match = re.fullmatch(r"(20\d{2})\.(\d{2})", name)
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}-01"


def previous_day(month_start: str) -> str:
    year, month, day = [int(part) for part in month_start.split("-")]
    return (date(year, month, day) - timedelta(days=1)).isoformat()


def taxable_additions(row: dict[str, Any]) -> dict[str, Any]:
    fields = [
        "weekend_holiday_allowance",
        "special_allowance",
        "skill_allowance",
        "housing_allowance",
        "childcare_allowance",
        "taxable_commute",
        "overtime_allowance",
        "retroactive_allowance",
        "night_allowance",
        "holiday_work_allowance",
        "base_salary_2",
        "gw_special_allowance",
        "paid_leave_buyout",
        "absence_deduction",
        "late_early_deduction",
        "obon_special_allowance",
        "covid_leave_allowance",
        "over_60h_overtime_amount",
        "solatium",
    ]
    return {field: row.get(field) for field in fields if row.get(field)}


def employee_where(row: dict[str, Any]) -> str:
    code = row.get("employee_code")
    name = normalize_name(row.get("name"))
    clauses = []
    if code:
        clauses.append(f"employee_code = {sql_literal(code)}")
    if name:
        clauses.append(
            "regexp_replace(coalesce(real_name, display_name), '[\\s　]+', '', 'g') = "
            + sql_literal(name)
        )
    return " OR ".join(clauses) or "false"


def collect_profiles(root: Path, latest_month: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or "賞与" in child.name:
            continue
        month_start = parse_month_name(child.name)
        if not month_start:
            continue
        if latest_month and month_start > latest_month:
            continue
        source_root = child / child.name if (child / child.name).exists() else child
        payload = parse_month(source_root)
        for row in payload["profiles"]:
            if not (row.get("base_salary") or row.get("taxable_payment_total")):
                continue
            profile = row["profile"]
            if profile["calculation_type"] == "unknown":
                continue
            rows.append({
                "month_start": month_start,
                "employee_code": row.get("employee_code"),
                "name": row.get("name"),
                "profile": profile,
                "source_snapshot": {key: value for key, value in row.items() if key != "profile"},
                "taxable_additions": taxable_additions(row),
            })
    rows.sort(key=lambda item: (item.get("employee_code") or normalize_name(item.get("name")), item["month_start"]))
    return rows


def build_sql(rows: list[dict[str, Any]]) -> str:
    by_key: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        key = row.get("employee_code") or normalize_name(row.get("name"))
        by_key.setdefault(key, []).append(row)

    statements = [
        "BEGIN;",
        "CREATE TEMP TABLE IF NOT EXISTS tmp_payroll_profile_missing (name text, employee_code text, month_start date);",
    ]

    for key_rows in by_key.values():
        for index, row in enumerate(key_rows):
            profile = row["profile"]
            effective_to = previous_day(key_rows[index + 1]["month_start"]) if index + 1 < len(key_rows) else None
            where = employee_where(row)
            values = {
                "effective_from": row["month_start"],
                "effective_to": effective_to,
                "calculation_type": profile["calculation_type"],
                "monthly_base_amount": profile.get("monthly_base_amount"),
                "hourly_rate": profile.get("hourly_rate"),
                "overtime_divisor": profile.get("overtime_divisor"),
                "weekday_saturday_overtime_multiplier": profile.get("weekday_saturday_overtime_multiplier", 1.25),
                "sunday_overtime_multiplier": profile.get("sunday_overtime_multiplier", 1.35),
                "scheduled_minutes": profile.get("scheduled_minutes"),
                "public_holidays_per_month": profile.get("public_holidays_per_month"),
                "paid_leave_mode": profile.get("paid_leave_mode"),
                "taxable_additions": row["taxable_additions"],
                "deduction_snapshot": profile.get("latest_deductions"),
                "source_snapshot": row["source_snapshot"],
                "verification": profile.get("verification"),
                "source_note": f"labor_office_inferred:{row['month_start'][:7]}",
            }
            statements.append(
                "WITH target_employee AS ("
                " SELECT id FROM gw_payroll_employees"
                f" WHERE {where}"
                " ORDER BY employee_code NULLS LAST, created_at LIMIT 1"
                "), missing AS ("
                " INSERT INTO tmp_payroll_profile_missing (name, employee_code, month_start)"
                f" SELECT {sql_literal(row.get('name'))}, {sql_literal(row.get('employee_code'))}, {sql_literal(row['month_start'])}::date"
                " WHERE NOT EXISTS (SELECT 1 FROM target_employee)"
                ")"
                " INSERT INTO gw_payroll_calculation_profiles ("
                "employee_id, effective_from, effective_to, calculation_type, monthly_base_amount, hourly_rate, overtime_divisor,"
                "weekday_saturday_overtime_multiplier, sunday_overtime_multiplier, scheduled_minutes, public_holidays_per_month,"
                "paid_leave_mode, taxable_additions, deduction_snapshot, source_snapshot, verification, source_note"
                ")"
                " SELECT id,"
                f" {sql_literal(values['effective_from'])}::date,"
                f" {sql_literal(values['effective_to'])}::date,"
                f" {sql_literal(values['calculation_type'])},"
                f" {sql_literal(values['monthly_base_amount'])},"
                f" {sql_literal(values['hourly_rate'])},"
                f" {sql_literal(values['overtime_divisor'])},"
                f" {sql_literal(values['weekday_saturday_overtime_multiplier'])},"
                f" {sql_literal(values['sunday_overtime_multiplier'])},"
                f" {sql_literal(values['scheduled_minutes'])},"
                f" {sql_literal(values['public_holidays_per_month'])},"
                f" {sql_literal(values['paid_leave_mode'])},"
                f" {sql_json(values['taxable_additions'])},"
                f" {sql_json(values['deduction_snapshot'])},"
                f" {sql_json(values['source_snapshot'])},"
                f" {sql_json(values['verification'])},"
                f" {sql_literal(values['source_note'])}"
                " FROM target_employee"
                " ON CONFLICT (employee_id, effective_from) DO UPDATE SET"
                " effective_to = excluded.effective_to,"
                " calculation_type = excluded.calculation_type,"
                " monthly_base_amount = excluded.monthly_base_amount,"
                " hourly_rate = excluded.hourly_rate,"
                " overtime_divisor = excluded.overtime_divisor,"
                " weekday_saturday_overtime_multiplier = excluded.weekday_saturday_overtime_multiplier,"
                " sunday_overtime_multiplier = excluded.sunday_overtime_multiplier,"
                " scheduled_minutes = excluded.scheduled_minutes,"
                " public_holidays_per_month = excluded.public_holidays_per_month,"
                " paid_leave_mode = excluded.paid_leave_mode,"
                " taxable_additions = excluded.taxable_additions,"
                " deduction_snapshot = excluded.deduction_snapshot,"
                " source_snapshot = excluded.source_snapshot,"
                " verification = excluded.verification,"
                " source_note = excluded.source_note,"
                " updated_at = now();"
            )

    statements.extend([
        "SELECT * FROM tmp_payroll_profile_missing ORDER BY month_start, employee_code, name;",
        "COMMIT;",
    ])
    return "\n".join(statements)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=r"C:\\作業用\\労務")
    parser.add_argument("--latest-month", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rows = collect_profiles(Path(args.root), args.latest_month or None)
    sql = build_sql(rows)
    Path(args.out).write_text(sql, encoding="utf-8")
    print(f"profiles={len(rows)} out={args.out}")


if __name__ == "__main__":
    main()
