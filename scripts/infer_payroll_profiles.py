from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber


def u(value: str) -> str:
    return value.encode("ascii").decode("unicode_escape")


ATTENDANCE_GRID_RIGHT = [187.8, 271.1, 354.5, 437.8, 521.1]
PAY_GRID_RIGHT = [229.4, 312.8, 396.1, 479.5, 562.8]
NAME_COLUMN_STARTS = [138.0, 221.0, 304.0, 388.0, 471.0, 555.0]

LABEL_TO_FIELD = {
    u("\\u51fa\\u52e4\\u65e5\\u6570"): "work_days",
    u("\\u4f11\\u65e5\\u51fa\\u52e4"): "holiday_work_days",
    u("\\u4ee3\\u4f11\\u65e5\\u6570"): "compensatory_days",
    u("\\u6709\\u7d66\\u65e5\\u6570"): "paid_leave_days",
    u("\\u7279\\u5225\\u4f11\\u6687"): "special_leave_days",
    u("\\u6b20\\u52e4\\u65e5\\u6570"): "absence_days",
    u("\\u5c31\\u52b4\\u6642\\u9593"): "work_minutes",
    u("\\u666e\\u901a\\u6b8b\\u696d"): "regular_overtime_minutes",
    u("\\u6df1\\u591c\\u52e4\\u52d9"): "night_minutes",
    u("\\u4f11\\u65e5\\u52e4\\u52d9"): "holiday_minutes",
    u("\\u9053\\u306e\\u99c5\\u52e4"): "michinoeki_minutes",
    u("\\u3057\\u3053\\u3093\\u52e4"): "shikon_minutes",
    u("\\u7814\\u4fee\\u6642\\u9593"): "training_minutes",
    u("\\u9061\\u53ca\\u6642\\u9593"): "retroactive_minutes",
    u("\\u65e9\\u51fa\\u6642\\u9593"): "early_start_minutes",
    u("\\u9045\\u65e9\\u56de\\u6570"): "late_early_count",
    u("\\u9045\\u65e9\\u6642\\u9593"): "late_early_minutes",
    u("\\u6cd5\\u5b9a\\u4f11\\u65e5"): "legal_holiday_minutes",
    u("\\u5e73\\u65e5\\u571f\\u66dc"): "weekday_saturday_overtime_minutes",
    u("\\u65e5\\u66dc\\u6b8b\\u696d"): "sunday_overtime_minutes",
    u("\\u571f\\u65e5\\u795d\\u52e4"): "weekend_holiday_minutes",
    u("\\u6708\\u0036\\u0030\\u6642\\u9593"): "over_60h_minutes",
}

PAYROLL_LABEL_TO_FIELD = {
    u("\\u672c\\u7d66"): "hourly_rate",
    u("\\u57fa\\u672c\\u7d66"): "base_salary",
    u("\\u571f\\u65e5\\u795d\\u52e4\\u624b\\u5f53"): "weekend_holiday_allowance",
    u("\\u7279\\u5225\\u624b\\u5f53"): "special_allowance",
    u("\\u6280\\u80fd\\u624b\\u5f53"): "skill_allowance",
    u("\\u4f4f\\u5b85\\u624b\\u5f53"): "housing_allowance",
    u("\\u80b2\\u5150\\u624b\\u5f53"): "childcare_allowance",
    u("\\u8ab2\\u7a0e\\u901a\\u52e4\\u624b\\u5f53"): "taxable_commute",
    u("\\u8d85\\u904e\\u52e4\\u52d9\\u624b\\u5f53"): "overtime_allowance",
    u("\\u9061\\u53ca\\u624b\\u5f53"): "retroactive_allowance",
    u("\\u6df1\\u591c\\u624b\\u5f53"): "night_allowance",
    u("\\u4f11\\u65e5\\u51fa\\u52e4\\u624b\\u5f53"): "holiday_work_allowance",
    u("\\u57fa\\u672c\\u7d66\\u0032"): "base_salary_2",
    u("\\u0047\\u0057\\u7279\\u5225\\u624b\\u5f53"): "gw_special_allowance",
    u("\\u6709\\u7d66\\u8cb7\\u53d6\\u624b\\u5f53"): "paid_leave_buyout",
    u("\\u6b20\\u52e4\\u63a7\\u9664"): "absence_deduction",
    u("\\u9045\\u65e9\\u63a7\\u9664"): "late_early_deduction",
    u("\\u304a\\u76c6\\u7279\\u5225\\u624b\\u5f53"): "obon_special_allowance",
    u("\\u30b3\\u30ed\\u30ca\\u4f11\\u696d\\u624b\\u5f53"): "covid_leave_allowance",
    u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d"): "weekday_saturday_overtime_amount",
    u("\\u65e5\\u66dc\\u6b8b\\u696d"): "sunday_overtime_amount",
    u("\\u6708\\u0036\\u0030\\u6642\\u9593\\u8d85\\u624b\\u5f53"): "over_60h_overtime_amount",
    u("\\u6170\\u52b4\\u91d1"): "solatium",
    u("\\u8ab2\\u7a0e\\u652f\\u7d66\\u5408\\u8a08"): "taxable_payment_total",
    u("\\u975e\\u8ab2\\u7a0e\\u901a\\u52e4\\u624b\\u5f53"): "non_taxable_commute",
    u("\\u89e3\\u96c7\\u4e88\\u544a\\u624b\\u5f53"): "dismissal_notice_allowance",
    u("\\u975e\\u8ab2\\u7a0e\\u652f\\u7d66\\u5408\\u8a08"): "non_taxable_payment_total",
    u("\\u652f\\u7d66\\u5408\\u8a08"): "payment_total",
    u("\\u5065\\u5eb7\\u4fdd\\u967a"): "health_insurance",
    u("\\u4ecb\\u8b77\\u4fdd\\u967a"): "care_insurance",
    u("\\u5b50\\u3069\\u3082\\u5b50\\u80b2\\u3066\\u652f\\u63f4\\u91d1"): "child_childcare_contribution",
    u("\\u539a\\u751f\\u5e74\\u91d1"): "welfare_pension",
    u("\\u96c7\\u7528\\u4fdd\\u967a"): "employment_insurance",
    u("\\u8abf\\u6574\\u4fdd\\u967a"): "insurance_adjustment",
    u("\\u793e\\u4fdd\\u63a7\\u9664\\u5408\\u8a08"): "social_insurance_total",
    u("\\u8ab2\\u7a0e\\u5bfe\\u8c61\\u984d"): "taxable_income",
    u("\\u6240\\u5f97\\u7a0e"): "income_tax",
    u("\\u5b9a\\u984d\\u6e1b\\u7a0e"): "fixed_tax_reduction",
    u("\\u4f4f\\u6c11\\u7a0e"): "resident_tax",
    u("\\u305d\\u306e\\u4ed6\\u63a7\\u9664"): "other_deduction",
    u("\\u793e\\u5b85\\u5bb6\\u8cc3"): "company_housing_rent",
    u("\\u5e74\\u8abf\\u7cbe\\u7b97\\u984d"): "year_end_adjustment",
    u("\\u305d\\u306e\\u4ed6\\u63a7\\u9664\\u5408\\u8a08"): "other_deduction_total",
    u("\\u63a7\\u9664\\u5408\\u8a08"): "deduction_total",
    u("\\u5dee\\u5f15\\u652f\\u7d66\\u984d"): "net_payment",
}

PAYROLL_LABELS = sorted(PAYROLL_LABEL_TO_FIELD, key=len, reverse=True)
ATTENDANCE_LABELS = sorted(LABEL_TO_FIELD, key=len, reverse=True)
NUMBER_RE = re.compile(r"-?\d{1,3}:\d{2}|-?\d{1,3}(?:,\d{3})+|-?\d{1,3}\.\d{2}|-?\d+")


@dataclass
class EmployeeMaster:
    code: str
    name: str
    compact_name: str
    hire_date: str | None


@dataclass
class PageEmployee:
    code: str | None
    name: str
    compact_name: str
    column_index: int


def compact(value: Any) -> str:
    return re.sub(r"[\s\u3000]+", "", str(value or ""))


def clean_number(text: str) -> float | int:
    text = text.replace(",", "")
    if ":" in text:
        sign = -1 if text.startswith("-") else 1
        text = text.lstrip("-")
        hours, minutes = text.split(":", 1)
        return sign * (int(hours) * 60 + int(minutes))
    if "." in text:
        return float(text)
    return int(text)


def is_numeric_text(text: str) -> bool:
    return bool(NUMBER_RE.fullmatch(text.replace(" ", "")))


def row_text(words: list[dict[str, Any]]) -> str:
    return " ".join(str(word["text"]) for word in words)


def group_words(words: list[dict[str, Any]], tolerance: float = 2.5) -> list[list[dict[str, Any]]]:
    rows: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (item["top"], item["x0"])):
        if not rows or abs(float(rows[-1][0]["top"]) - float(word["top"])) > tolerance:
            rows.append([word])
        else:
            rows[-1].append(word)
    return [sorted(row, key=lambda item: item["x0"]) for row in rows]


def find_pdf(root: Path, suffix: str) -> Path:
    matches = sorted(path for path in root.rglob("*.pdf") if path.name.endswith(suffix))
    if not matches:
        raise FileNotFoundError(f"missing PDF ending with {suffix}: {root}")
    return matches[0]


def extract_master(root: Path) -> dict[str, EmployeeMaster]:
    master_pdf = next((path for path in root.rglob("*.pdf") if u("\\u652f\\u7d66\\u6642\\u70b9\\u5f93\\u696d\\u54e1\\u4e00\\u89a7") in path.name), None)
    if not master_pdf:
        return {}

    with pdfplumber.open(str(master_pdf)) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    masters: dict[str, EmployeeMaster] = {}
    line_re = re.compile(r"^\s*(\d+)\s+(.+?)\s+[\uff61-\uff9fA-Za-z ]+\s+(\d{4}/\d{1,2}/\d{1,2})\s+(\d{4}/\d{1,2}/\d{1,2})")
    for line in text.splitlines():
        match = line_re.match(line)
        if not match:
            continue
        code = match.group(1)
        name = match.group(2).strip()
        hire = match.group(4).replace("/", "-")
        parts = hire.split("-")
        hire_date = f"{int(parts[0]):04d}-{int(parts[1]):02d}-{int(parts[2]):02d}"
        masters[compact(name)] = EmployeeMaster(code=code, name=name, compact_name=compact(name), hire_date=hire_date)

    alias = {compact(u("\\u9234\\u6728\\u7d50\\u82bd\\u9999")): compact(u("\\u68ee\\u7d50\\u82bd\\u9999"))}
    for alias_key, target_key in alias.items():
        if target_key in masters:
            masters[alias_key] = masters[target_key]
    return masters


def nearest_index(x1: float, grid: list[float]) -> tuple[int, float]:
    distances = [abs(x1 - value) for value in grid]
    index = min(range(len(distances)), key=distances.__getitem__)
    return index, distances[index]


def split_name_groups(words: list[dict[str, Any]]) -> list[str]:
    groups: list[list[str]] = [[] for _ in range(len(NAME_COLUMN_STARTS) - 1)]
    for word in words:
        text = str(word["text"])
        if word["x0"] < 130:
            continue
        if text in {"名"}:
            continue
        x0 = float(word["x0"])
        column = next((index for index in range(len(NAME_COLUMN_STARTS) - 1) if NAME_COLUMN_STARTS[index] <= x0 < NAME_COLUMN_STARTS[index + 1]), None)
        if column is None:
            continue
        groups[column].append(text)
    names = []
    for group in groups:
        name = " ".join(group).strip()
        key = compact(name)
        if not key or key.isdigit() or (key.endswith(u("\\u540d")) and key[:-1].isdigit()):
            continue
        names.append(name)
    return names


def page_employees(rows: list[list[dict[str, Any]]], masters: dict[str, EmployeeMaster]) -> list[PageEmployee]:
    for index, words in enumerate(rows):
        text = compact(row_text(words))
        if text.startswith(u("\\u793e\\u54e1")) or (u("\\u793e") in text and u("\\u54e1") in text and index + 1 < len(rows)):
            candidates = split_name_groups(words)
            if not candidates and index + 1 < len(rows):
                candidates = split_name_groups(rows[index + 1])
            employees: list[PageEmployee] = []
            for column_index, name in enumerate(candidates):
                key = compact(name)
                if key.endswith(u("\\u540d")) and key[:-1].isdigit():
                    continue
                master = masters.get(key)
                employees.append(PageEmployee(master.code if master else None, master.name if master else name, key, column_index))
            return employees
    return []


def numeric_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [word for word in words if is_numeric_text(str(word["text"]).replace(" ", ""))]


def best_payroll_label(text: str) -> tuple[str, str] | None:
    compact_text = compact(text)
    if compact_text == compact(u("\\u57fa\\u672c\\u7d66\\u0032")):
        return u("\\u57fa\\u672c\\u7d66\\u0032"), "base_salary_2"
    for label in PAYROLL_LABELS:
        if label == u("\\u57fa\\u672c\\u7d66\\u0032"):
            continue
        if compact(label) in compact_text:
            return label, PAYROLL_LABEL_TO_FIELD[label]
    return None


def attendance_labels_for_row(words: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    left_text = compact(row_text([word for word in words if float(word["x0"]) < 100]))
    right_text = compact(row_text([word for word in words if 96 <= float(word["x0"]) < 142]))
    left_label = next((label for label in ATTENDANCE_LABELS if compact(label) in left_text), None)
    right_label = next((label for label in ATTENDANCE_LABELS if compact(label) in right_text), None)
    return left_label, right_label


def set_value(rows: dict[int, dict[str, Any]], index: int, field: str, value: float | int) -> None:
    if value in (0, 0.0) and field in rows[index]:
        return
    rows[index][field] = value


def parse_statement_page(page: Any, masters: dict[str, EmployeeMaster], page_number: int) -> list[dict[str, Any]]:
    rows = group_words(page.extract_words(x_tolerance=1, y_tolerance=3, keep_blank_chars=False))
    employees = page_employees(rows, masters)
    if not employees:
        return []

    parsed: dict[int, dict[str, Any]] = {
        employee.column_index: {
            "employee_code": employee.code,
            "name": employee.name,
            "source_page": page_number,
        }
        for employee in employees
    }
    employee_count = len(employees)

    for words in rows:
        text = row_text(words)
        numbers = numeric_words(words)
        if not numbers:
            continue

        payroll_label = best_payroll_label(text)
        is_payroll_row = bool(payroll_label) and min(float(word["x0"]) for word in words) < 54
        if is_payroll_row and payroll_label:
            _, field = payroll_label
            for word in numbers:
                index, distance = nearest_index(float(word["x1"]), PAY_GRID_RIGHT)
                if index >= employee_count or distance > 20:
                    continue
                set_value(parsed, index, field, clean_number(str(word["text"])))
            continue

        left_label, right_label = attendance_labels_for_row(words)
        if left_label or right_label:
            for word in numbers:
                value = clean_number(str(word["text"]))
                left_index, left_distance = nearest_index(float(word["x1"]), ATTENDANCE_GRID_RIGHT)
                right_index, right_distance = nearest_index(float(word["x1"]), PAY_GRID_RIGHT)
                if left_index >= employee_count and right_index >= employee_count:
                    continue
                if left_label and (left_distance <= right_distance or not right_label):
                    if left_index < employee_count:
                        set_value(parsed, left_index, LABEL_TO_FIELD[left_label], value)
                elif right_label and right_index < employee_count:
                    set_value(parsed, right_index, LABEL_TO_FIELD[right_label], value)
            continue

        if not payroll_label:
            continue
        _, field = payroll_label
        for word in numbers:
            index, distance = nearest_index(float(word["x1"]), PAY_GRID_RIGHT)
            if index >= employee_count or distance > 20:
                continue
            set_value(parsed, index, field, clean_number(str(word["text"])))

    return list(parsed.values())


def infer_divisor(base_salary: float, minutes: float, amount: float, multiplier: float) -> int | None:
    if not base_salary or not minutes or not amount:
        return None
    hours = minutes / 60
    divisor = base_salary / (amount / hours / multiplier)
    candidates = [135, 168, 176, 184, 192, 196, 200]
    best = min(candidates, key=lambda item: abs(item - divisor))
    return best if abs(best - divisor) <= 8 else round(divisor)


def yen_round(value: float) -> int:
    return int(math.floor(value + 0.5))


def classify(row: dict[str, Any]) -> dict[str, Any]:
    base_salary = float(row.get("base_salary") or 0)
    hourly_rate = float(row.get("hourly_rate") or 0)
    work_minutes = int(row.get("work_minutes") or 0)
    weekday_ot_minutes = int(row.get("weekday_saturday_overtime_minutes") or row.get("regular_overtime_minutes") or 0)
    sunday_ot_minutes = int(row.get("sunday_overtime_minutes") or 0)
    weekday_ot_amount = float(row.get("weekday_saturday_overtime_amount") or 0)
    sunday_ot_amount = float(row.get("sunday_overtime_amount") or 0)
    taxable_additions = sum(
        float(row.get(field) or 0)
        for field in [
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
    )

    inferred_rate = hourly_rate or None
    if not inferred_rate and base_salary and work_minutes:
        raw_rate = base_salary / (work_minutes / 60)
        nearest_ten = round(raw_rate / 10) * 10
        if 950 <= nearest_ten <= 1300 and abs(base_salary - nearest_ten * work_minutes / 60) <= 2:
            inferred_rate = float(nearest_ten)

    if inferred_rate:
        calculation_type = "hourly"
        monthly_base_amount = None
        overtime_divisor = None
    elif base_salary and (weekday_ot_minutes or sunday_ot_minutes):
        calculation_type = "monthly_with_overtime"
        monthly_base_amount = base_salary
        divisors = [
            value for value in [
                infer_divisor(base_salary, weekday_ot_minutes, weekday_ot_amount, 1.25),
                infer_divisor(base_salary, sunday_ot_minutes, sunday_ot_amount, 1.35),
            ]
            if value
        ]
        overtime_divisor = round(sum(divisors) / len(divisors)) if divisors else None
    elif base_salary:
        calculation_type = "officer_fixed" if base_salary >= 300000 and not work_minutes else "monthly_fixed"
        monthly_base_amount = base_salary
        overtime_divisor = None
    else:
        calculation_type = "unknown"
        monthly_base_amount = None
        overtime_divisor = None

    scheduled_minutes = None
    if overtime_divisor in {168, 135}:
        scheduled_minutes = 390
    elif overtime_divisor in {192, 196, 200}:
        scheduled_minutes = 480

    source_taxable = int(row.get("taxable_payment_total") or base_salary or 0)

    if calculation_type == "hourly":
        calculated_taxable = yen_round((work_minutes / 60) * (inferred_rate or 0) + taxable_additions)
        match_delta = calculated_taxable - source_taxable
    elif calculation_type == "monthly_with_overtime":
        calculated_taxable = int((monthly_base_amount or 0) + taxable_additions)
        if overtime_divisor:
            calculated_taxable += yen_round((monthly_base_amount or 0) / overtime_divisor * 1.25 * weekday_ot_minutes / 60)
            calculated_taxable += yen_round((monthly_base_amount or 0) / overtime_divisor * 1.35 * sunday_ot_minutes / 60)
        match_delta = calculated_taxable - int(row.get("taxable_payment_total") or calculated_taxable)
    else:
        calculated_taxable = int(monthly_base_amount or 0)
        match_delta = calculated_taxable - int(row.get("taxable_payment_total") or calculated_taxable)

    return {
        "calculation_type": calculation_type,
        "monthly_base_amount": monthly_base_amount,
        "hourly_rate": inferred_rate,
        "overtime_divisor": overtime_divisor,
        "weekday_saturday_overtime_multiplier": 1.25,
        "sunday_overtime_multiplier": 1.35,
        "scheduled_minutes": scheduled_minutes,
        "public_holidays_per_month": 6 if calculation_type.startswith("monthly") else None,
        "paid_leave_mode": "excess_blank_days_over_public_holidays" if calculation_type.startswith("monthly") else None,
        "latest_attendance": {
            "work_days": row.get("work_days") or 0,
            "work_minutes": work_minutes,
            "weekday_saturday_overtime_minutes": weekday_ot_minutes,
            "sunday_overtime_minutes": sunday_ot_minutes,
        },
        "latest_deductions": {
            "health_insurance": row.get("health_insurance") or 0,
            "care_insurance": row.get("care_insurance") or 0,
            "child_childcare_contribution": row.get("child_childcare_contribution") or 0,
            "welfare_pension": row.get("welfare_pension") or 0,
            "employment_insurance": row.get("employment_insurance") or 0,
            "income_tax": row.get("income_tax") or 0,
            "resident_tax": row.get("resident_tax") or 0,
            "other_deduction_total": row.get("other_deduction_total") or 0,
        },
        "verification": {
            "calculated_taxable_payment": calculated_taxable,
            "source_taxable_payment": row.get("taxable_payment_total") or 0,
            "delta": match_delta,
        },
    }


def parse_month(root: Path) -> dict[str, Any]:
    masters = extract_master(root)
    statement = find_pdf(root, u("\\u652f\\u7d66\\u63a7\\u9664\\u4e00\\u89a7\\u8868.pdf"))
    rows: list[dict[str, Any]] = []
    with pdfplumber.open(str(statement)) as pdf:
        for page_number, page in enumerate(pdf.pages, 1):
            rows.extend(parse_statement_page(page, masters, page_number))

    profiles = [{**row, "profile": classify(row)} for row in rows if row.get("name")]
    return {
        "source_root": str(root),
        "statement": str(statement),
        "profiles": profiles,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=r"C:\\作業用\\労務\\2026.06")
    parser.add_argument("--out")
    args = parser.parse_args()

    payload = parse_month(Path(args.root))
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
