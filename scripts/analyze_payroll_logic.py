from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pypdf import PdfReader


def u(value: str) -> str:
    return value.encode("ascii").decode("unicode_escape")


ATTENDANCE_LABELS = [
    u("\\u51fa\\u52e4\\u65e5\\u6570"),  # 出勤日数
    u("\\u4f11\\u65e5\\u51fa\\u52e4"),  # 休日出勤
    u("\\u4ee3\\u4f11\\u65e5\\u6570"),  # 代休日数
    u("\\u6709\\u7d66\\u65e5\\u6570"),  # 有給日数
    u("\\u7279\\u5225\\u4f11\\u6687"),  # 特別休暇
    u("\\u6b20\\u52e4\\u65e5\\u6570"),  # 欠勤日数
    u("\\u5c31\\u52b4\\u6642\\u9593"),  # 就労時間
    u("\\u666e\\u901a\\u6b8b\\u696d"),  # 普通残業
    u("\\u6df1\\u591c\\u52e4\\u52d9"),  # 深夜勤務
    u("\\u4f11\\u65e5\\u52e4\\u52d9"),  # 休日勤務
    u("\\u9053\\u306e\\u99c5\\u52e4"),  # 道の駅勤
    u("\\u3057\\u3053\\u3093\\u52e4"),  # しこん勤
    u("\\u30d6\\u30e9\\u30f3\\u30c9\\u9928\\u52e4"),  # ブランド館勤
    u("\\u7814\\u4fee\\u6642\\u9593"),  # 研修時間
    u("\\u9061\\u53ca\\u6642\\u9593"),  # 遡及時間
    u("\\u65e9\\u51fa\\u6642\\u9593"),  # 早出時間
    u("\\u9045\\u65e9\\u56de\\u6570"),  # 遅早回数
    u("\\u9045\\u65e9\\u6642\\u9593"),  # 遅早時間
    u("\\u6cd5\\u5b9a\\u4f11\\u65e5"),  # 法定休日
    u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d"),  # 平日土曜残業
    u("\\u65e5\\u66dc\\u6b8b\\u696d"),  # 日曜残業
    u("\\u571f\\u65e5\\u795d\\u52e4"),  # 土日祝勤
    u("\\u6708\\u0036\\u0030\\u6642\\u9593\\u8d85"),  # 月60時間超
]

PAYROLL_LABELS = [
    u("\\u672c\\u7d66"),  # 本給
    u("\\u57fa\\u672c\\u7d66"),  # 基本給
    u("\\u571f\\u65e5\\u795d\\u52e4\\u624b\\u5f53"),  # 土日祝勤手当
    u("\\u7279\\u5225\\u624b\\u5f53"),  # 特別手当
    u("\\u6280\\u80fd\\u624b\\u5f53"),  # 技能手当
    u("\\u4f4f\\u5b85\\u624b\\u5f53"),  # 住宅手当
    u("\\u80b2\\u5150\\u624b\\u5f53"),  # 育児手当
    u("\\u8ab2\\u7a0e\\u901a\\u52e4\\u624b\\u5f53"),  # 課税通勤手当
    u("\\u8d85\\u904e\\u52e4\\u52d9\\u624b\\u5f53"),  # 超過勤務手当
    u("\\u666e\\u901a\\u6b8b\\u696d"),  # 普通残業
    u("\\u9061\\u53ca\\u624b\\u5f53"),  # 遡及手当
    u("\\u6df1\\u591c\\u624b\\u5f53"),  # 深夜手当
    u("\\u4f11\\u65e5\\u51fa\\u52e4\\u624b\\u5f53"),  # 休日出勤手当
    u("\\u57fa\\u672c\\u7d66\\u0032"),  # 基本給2
    u("\\u0047\\u0057\\u7279\\u5225\\u624b\\u5f53"),  # GW特別手当
    u("\\u6709\\u7d66\\u8cb7\\u53d6\\u624b\\u5f53"),  # 有給買取手当
    u("\\u6b20\\u52e4\\u63a7\\u9664"),  # 欠勤控除
    u("\\u9045\\u65e9\\u63a7\\u9664"),  # 遅早控除
    u("\\u304a\\u76c6\\u7279\\u5225\\u624b\\u5f53"),  # お盆特別手当
    u("\\u30b3\\u30ed\\u30ca\\u4f11\\u696d\\u624b\\u5f53"),  # コロナ休業手当
    u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d"),  # 平日土曜残業
    u("\\u65e5\\u66dc\\u6b8b\\u696d"),  # 日曜残業
    u("\\u6708\\u0036\\u0030\\u6642\\u9593\\u8d85\\u624b\\u5f53"),  # 月60時間超手当
    u("\\u6170\\u52b4\\u91d1"),  # 慰労金
    u("\\u8ab2\\u7a0e\\u652f\\u7d66\\u5408\\u8a08"),  # 課税支給合計
    u("\\u975e\\u8ab2\\u7a0e\\u901a\\u52e4\\u624b\\u5f53"),  # 非課税通勤手当
    u("\\u89e3\\u96c7\\u4e88\\u544a\\u624b\\u5f53"),  # 解雇予告手当
    u("\\u975e\\u8ab2\\u7a0e\\u652f\\u7d66\\u5408\\u8a08"),  # 非課税支給合計
    u("\\u652f\\u7d66\\u5408\\u8a08"),  # 支給合計
    u("\\u5065\\u5eb7\\u4fdd\\u967a"),  # 健康保険
    u("\\u4ecb\\u8b77\\u4fdd\\u967a"),  # 介護保険
    u("\\u5b50\\u3069\\u3082\\u5b50\\u80b2\\u3066\\u652f\\u63f4\\u91d1"),  # 子ども子育て支援金
    u("\\u539a\\u751f\\u5e74\\u91d1"),  # 厚生年金
    u("\\u96c7\\u7528\\u4fdd\\u967a"),  # 雇用保険
    u("\\u8abf\\u6574\\u4fdd\\u967a"),  # 調整保険
    u("\\u793e\\u4fdd\\u63a7\\u9664\\u5408\\u8a08"),  # 社保控除合計
    u("\\u8ab2\\u7a0e\\u5bfe\\u8c61\\u984d"),  # 課税対象額
    u("\\u6240\\u5f97\\u7a0e"),  # 所得税
    u("\\u5b9a\\u984d\\u6e1b\\u7a0e"),  # 定額減税
    u("\\u4f4f\\u6c11\\u7a0e"),  # 住民税
    u("\\u305d\\u306e\\u4ed6\\u63a7\\u9664"),  # その他控除
    u("\\u793e\\u5b85\\u5bb6\\u8cc3"),  # 社宅家賃
    u("\\u5e74\\u8abf\\u7cbe\\u7b97\\u984d"),  # 年調精算額
    u("\\u305d\\u306e\\u4ed6\\u63a7\\u9664\\u5408\\u8a08"),  # その他控除合計
    u("\\u63a7\\u9664\\u5408\\u8a08"),  # 控除合計
    u("\\u5dee\\u5f15\\u652f\\u7d66\\u984d"),  # 差引支給額
    u("\\u73fe\\u91d1\\u652f\\u7d66\\u984d"),  # 現金支給額
    u("\\u632f\\u8fbc\\u652f\\u7d66\\u984d"),  # 振込支給額
    u("\\u7a0e\\u5236\\u6276\\u990a\\u6570"),  # 税制扶養数
    u("\\u7a0e\\u8868\\u533a\\u5206"),  # 税表区分
]

LABELS = ATTENDANCE_LABELS + [label for label in PAYROLL_LABELS if label not in ATTENDANCE_LABELS]
ATTENDANCE_VALUE_LABELS = set(ATTENDANCE_LABELS)
TIME_LABELS = {
    u("\\u5c31\\u52b4\\u6642\\u9593"),
    u("\\u666e\\u901a\\u6b8b\\u696d"),
    u("\\u6df1\\u591c\\u52e4\\u52d9"),
    u("\\u4f11\\u65e5\\u52e4\\u52d9"),
    u("\\u9053\\u306e\\u99c5\\u52e4"),
    u("\\u3057\\u3053\\u3093\\u52e4"),
    u("\\u30d6\\u30e9\\u30f3\\u30c9\\u9928\\u52e4"),
    u("\\u7814\\u4fee\\u6642\\u9593"),
    u("\\u9061\\u53ca\\u6642\\u9593"),
    u("\\u65e9\\u51fa\\u6642\\u9593"),
    u("\\u9045\\u65e9\\u6642\\u9593"),
    u("\\u6cd5\\u5b9a\\u4f11\\u65e5"),
    u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d"),
    u("\\u65e5\\u66dc\\u6b8b\\u696d"),
    u("\\u571f\\u65e5\\u795d\\u52e4"),
    u("\\u6708\\u0036\\u0030\\u6642\\u9593\\u8d85"),
}

FIELD = {
    "base_salary": u("\\u57fa\\u672c\\u7d66"),
    "base_wage": u("\\u672c\\u7d66"),
    "work_minutes": u("\\u5c31\\u52b4\\u6642\\u9593_minutes"),
    "weekday_overtime_minutes": u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d_minutes"),
    "regular_overtime_minutes": u("\\u666e\\u901a\\u6b8b\\u696d_minutes"),
    "sunday_overtime_minutes": u("\\u65e5\\u66dc\\u6b8b\\u696d_minutes"),
    "weekday_overtime_amount": u("\\u5e73\\u65e5\\u571f\\u66dc\\u6b8b\\u696d"),
    "regular_overtime_amount": u("\\u666e\\u901a\\u6b8b\\u696d"),
    "sunday_overtime_amount": u("\\u65e5\\u66dc\\u6b8b\\u696d"),
    "work_days": u("\\u51fa\\u52e4\\u65e5\\u6570"),
    "paid_leave_days": u("\\u6709\\u7d66\\u65e5\\u6570"),
    "absence_days": u("\\u6b20\\u52e4\\u65e5\\u6570"),
}

NUM_RE = re.compile(r"-?\d{1,3}:\d{2}|-?\d{1,3}(?:,\d{3})+|-?\d{1,2}\.\d{2}|-?\d+")
BASIC_SALARY_LABEL = u("\\u57fa\\u672c\\u7d66")
BASIC_SALARY_2_LABEL = u("\\u57fa\\u672c\\u7d66\\u0032")


@dataclass
class EmployeeName:
    code: str
    name: str
    compact_name: str


def compact(value: Any) -> str:
    return "".join(str(value).split())


def compact_name(value: str) -> str:
    return re.sub(r"[\s\u3000（）()・]", "", value)


def parse_number(token: str) -> float | int:
    token = token.replace(",", "")
    if ":" in token:
        sign = -1 if token.startswith("-") else 1
        token = token.lstrip("-")
        hours, minutes = token.split(":", 1)
        return sign * (int(hours) * 60 + int(minutes))
    if "." in token:
        return float(token)
    return int(token)


def extract_numbers(value: str) -> list[float | int]:
    return [parse_number(match.group(0)) for match in NUM_RE.finditer(value)]


def read_text(path: Path) -> list[str]:
    reader = PdfReader(str(path))
    return [page.extract_text() or "" for page in reader.pages]


def find_pdf(root: Path, pattern: str) -> Path:
    matches = sorted(root.glob(pattern))
    if not matches:
        raise FileNotFoundError(f"PDF not found: {root} / {pattern}")
    return matches[0]


def extract_employee_master(root: Path) -> list[EmployeeName]:
    master = find_pdf(root, "**/*支給時点従業員一覧.pdf")
    employees: list[EmployeeName] = []
    line_re = re.compile(r"^\s*(\d+)\s+(.+?)\s+[\uff66-\uff9fA-Za-z ]+\s+\d{4}/")
    for text in read_text(master):
        for line in text.splitlines():
            match = line_re.match(line.strip())
            if not match:
                continue
            name = match.group(2).strip()
            employees.append(EmployeeName(code=match.group(1), name=name, compact_name=compact_name(name)))
    return employees


def labels_for_line(line: str) -> list[str]:
    compact_line = compact(line)
    return [label for label in LABELS if compact(label) in compact_line]


def should_use_label(line: str, label: str) -> bool:
    compact_line = compact(line)
    compact_label = compact(label)

    # Horizontal payroll PDFs can compact "247,000 基本給 223,000" into a
    # string that contains "基本給2". Treat "基本給2" as a label only when the
    # row itself starts with that label.
    if label == BASIC_SALARY_2_LABEL:
        return compact_line.startswith(compact_label)
    if label == BASIC_SALARY_LABEL and compact_line.startswith(compact(BASIC_SALARY_2_LABEL)):
        return False
    return True


def values_for_label(line: str, label: str, employee_count: int) -> list[float | int] | None:
    compact_line = compact(line)
    compact_label = compact(label)
    if compact_label not in compact_line:
        return None
    before, after = compact_line.split(compact_label, 1)
    before_values = extract_numbers(before)
    after_values = extract_numbers(after)

    if employee_count <= 1:
        if before_values and after_values and before_values[-1] == after_values[0]:
            return [before_values[-1]]
        return [before_values[-1] if before_values else (after_values[0] if after_values else 0)]

    if label in ATTENDANCE_VALUE_LABELS and len(after_values) >= employee_count:
        return after_values[:employee_count]
    if not before_values and len(after_values) >= employee_count:
        return after_values[:employee_count]

    values: list[float | int] = []
    if before_values:
        values.append(before_values[-1])
    values.extend(after_values)
    while len(values) < employee_count:
        values.append(0)
    return values[:employee_count]


def detect_page_employees(text: str, employees: list[EmployeeName]) -> list[EmployeeName]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    header = compact_name(compact("\n".join(lines[:8])))
    page_employees = [employee for employee in employees if employee.compact_name and employee.compact_name in header]
    if page_employees:
        return page_employees

    all_text = compact_name(compact(text))
    return [employee for employee in employees if employee.compact_name and employee.compact_name in all_text]


def merge_page_rows(existing: dict[str, dict[str, Any]], next_rows: dict[str, dict[str, Any]]) -> None:
    for code, row in next_rows.items():
        current = existing.setdefault(code, {"employee_code": code, "name": row["name"], "pages": []})
        current["pages"].extend(row.get("pages", []))
        for key, value in row.items():
            if key in {"employee_code", "name", "pages"}:
                continue
            if value in ("", None, 0, 0.0) and key in current:
                continue
            current[key] = value


def extract_statement_rows(root: Path) -> dict[str, dict[str, Any]]:
    employees = extract_employee_master(root)
    statement = find_pdf(root, "**/*支給控除一覧表.pdf")
    rows: dict[str, dict[str, Any]] = {}
    for page_number, text in enumerate(read_text(statement), 1):
        page_employees = detect_page_employees(text, employees)
        if not page_employees:
            continue

        page_rows = {
            employee.code: {"employee_code": employee.code, "name": employee.name, "pages": [page_number]}
            for employee in page_employees
        }
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for line in lines:
            for label in sorted(labels_for_line(line), key=len, reverse=True):
                if not should_use_label(line, label):
                    continue
                values = values_for_label(line, label, len(page_employees))
                if values is None:
                    continue
                if label in TIME_LABELS and ":" in compact(line):
                    field = f"{label}_minutes"
                else:
                    field = label
                for employee, value in zip(page_employees, values):
                    page_rows[employee.code][field] = value
                break
        merge_page_rows(rows, page_rows)
    return rows


def classify(row: dict[str, Any]) -> dict[str, Any]:
    base_salary = float(row.get(FIELD["base_salary"]) or 0)
    work_minutes = int(row.get(FIELD["work_minutes"]) or 0)
    weekday_overtime_minutes = int(row.get(FIELD["weekday_overtime_minutes"]) or row.get(FIELD["regular_overtime_minutes"]) or 0)
    sunday_overtime_minutes = int(row.get(FIELD["sunday_overtime_minutes"]) or 0)
    weekday_overtime_amount = float(row.get(FIELD["weekday_overtime_amount"]) or row.get(FIELD["regular_overtime_amount"]) or 0)
    sunday_overtime_amount = float(row.get(FIELD["sunday_overtime_amount"]) or 0)

    inferred_hourly_rate = None
    if base_salary and work_minutes:
        raw_rate = base_salary / (work_minutes / 60)
        nearest_ten = round(raw_rate / 10) * 10
        if 950 <= nearest_ten <= 1300 and abs(base_salary - (nearest_ten * work_minutes / 60)) <= 2000:
            inferred_hourly_rate = float(nearest_ten)

    if base_salary >= 300000 and work_minutes == 0:
        calculation_type = "officer_fixed"
        monthly_base_amount = base_salary
        hourly_rate = None
        overtime_divisor = None
    elif inferred_hourly_rate:
        calculation_type = "hourly"
        monthly_base_amount = None
        hourly_rate = inferred_hourly_rate
        overtime_divisor = None
    else:
        calculation_type = "monthly_with_overtime" if (weekday_overtime_minutes or sunday_overtime_minutes) else "monthly_fixed"
        monthly_base_amount = base_salary
        hourly_rate = None
        candidates: list[float] = []
        if weekday_overtime_minutes and weekday_overtime_amount and monthly_base_amount:
            candidates.append(monthly_base_amount / (weekday_overtime_amount / (weekday_overtime_minutes / 60) / 1.25))
        if sunday_overtime_minutes and sunday_overtime_amount and monthly_base_amount:
            candidates.append(monthly_base_amount / (sunday_overtime_amount / (sunday_overtime_minutes / 60) / 1.35))
        overtime_divisor = round(sum(candidates) / len(candidates)) if candidates else None

    total_days = float(row.get(FIELD["work_days"]) or 0)
    paid_leave_days = float(row.get(FIELD["paid_leave_days"]) or 0)
    absence_days = float(row.get(FIELD["absence_days"]) or 0)
    public_holidays = 6 if calculation_type in {"monthly_with_overtime", "monthly_fixed"} and total_days else None

    return {
        "calculation_type": calculation_type,
        "monthly_base_amount": monthly_base_amount,
        "hourly_rate": hourly_rate,
        "overtime_divisor": overtime_divisor,
        "scheduled_start": "08:30" if calculation_type in {"monthly_with_overtime", "monthly_fixed"} else None,
        "scheduled_end": "16:30" if calculation_type in {"monthly_with_overtime", "monthly_fixed"} else None,
        "scheduled_minutes": 390 if overtime_divisor == 168 else (480 if overtime_divisor == 192 else None),
        "public_holidays_per_month": public_holidays,
        "paid_leave_mode": "excess_blank_days_over_public_holidays" if public_holidays else None,
        "latest_attendance": {
            "work_days": total_days,
            "paid_leave_days": paid_leave_days,
            "absence_days": absence_days,
            "work_minutes": work_minutes,
            "weekday_saturday_overtime_minutes": weekday_overtime_minutes,
            "sunday_overtime_minutes": sunday_overtime_minutes,
        },
        "latest_deductions": {
            "health_insurance": row.get(u("\\u5065\\u5eb7\\u4fdd\\u967a")) or 0,
            "care_insurance": row.get(u("\\u4ecb\\u8b77\\u4fdd\\u967a")) or 0,
            "child_childcare_contribution": row.get(u("\\u5b50\\u3069\\u3082\\u5b50\\u80b2\\u3066\\u652f\\u63f4\\u91d1")) or 0,
            "welfare_pension": row.get(u("\\u539a\\u751f\\u5e74\\u91d1")) or 0,
            "employment_insurance": row.get(u("\\u96c7\\u7528\\u4fdd\\u967a")) or 0,
            "income_tax": row.get(u("\\u6240\\u5f97\\u7a0e")) or 0,
            "resident_tax": row.get(u("\\u4f4f\\u6c11\\u7a0e")) or 0,
            "company_housing_rent": row.get(u("\\u793e\\u5b85\\u5bb6\\u8cc3")) or 0,
            "other_deduction": row.get(u("\\u305d\\u306e\\u4ed6\\u63a7\\u9664\\u5408\\u8a08")) or 0,
        },
        "source_snapshot": {key: value for key, value in row.items() if key != "pages"},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=r"C:\作業用\労務\2026.06", help="Payroll month root folder")
    parser.add_argument("--out", help="Optional JSON output path")
    args = parser.parse_args()

    root = Path(args.root)
    rows = extract_statement_rows(root)
    profiles = []
    for code in sorted(rows, key=lambda value: int(value) if value.isdigit() else value):
        row = rows[code]
        profiles.append({**row, "profile": classify(row)})

    payload = {"source_root": str(root), "profiles": profiles}
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
