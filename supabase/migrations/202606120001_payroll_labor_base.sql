-- TSG payroll / labor management base schema
-- Phase 1: store all labor-office payroll source data, link payroll employees to TSG users,
-- and prepare attendance records for payroll calculation.

CREATE TABLE IF NOT EXISTS gw_workplaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  department TEXT CHECK (department IN ('フロア', '製造', '道の駅')),
  category TEXT NOT NULL DEFAULT 'workplace',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gw_workplaces (code, name, department, category, sort_order)
VALUES
  ('hq', '本社', '製造', 'office', 10),
  ('aizu_brandhall', '会津ブランド館', 'フロア', 'store', 20),
  ('michinoeki', '道の駅', '道の駅', 'store', 30),
  ('food_brandhall', '食のブランド館', '道の駅', 'store', 40),
  ('aizu_shikon', '会津しこん', '製造', 'store', 50)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  department = EXCLUDED.department,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE TABLE IF NOT EXISTS gw_feature_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT NOT NULL,
  role_key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  UNIQUE (feature_key, role_key, user_id)
);

INSERT INTO gw_feature_roles (feature_key, role_key, user_id, note)
SELECT 'payroll', 'manager', id, '初期給与担当'
FROM gw_users
WHERE regexp_replace(COALESCE(real_name, display_name), '\s|　', '', 'g') IN ('佐藤正彦', '佐藤ちさと')
ON CONFLICT (feature_key, role_key, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gw_payroll_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  employee_code TEXT UNIQUE,
  display_name TEXT NOT NULL,
  real_name TEXT,
  kana TEXT,
  birth_date DATE,
  hire_date DATE,
  resigned_date DATE,
  gender TEXT CHECK (gender IN ('male', 'female', 'other', 'unknown')),
  department TEXT CHECK (department IN ('フロア', '製造', '道の駅')),
  default_workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  employment_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (employment_type IN ('officer', 'monthly', 'hourly', 'part_time', 'temporary', 'unknown')),
  pay_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (pay_type IN ('monthly', 'hourly', 'daily', 'unknown')),
  payroll_status TEXT NOT NULL DEFAULT 'active'
    CHECK (payroll_status IN ('active', 'inactive', 'retired')),
  source_key TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_payroll_employees_user_id
  ON gw_payroll_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_gw_payroll_employees_status
  ON gw_payroll_employees(payroll_status);
CREATE INDEX IF NOT EXISTS idx_gw_payroll_employees_workplace
  ON gw_payroll_employees(default_workplace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_payroll_employees_user_unique
  ON gw_payroll_employees(user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gw_employee_workplace_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE CASCADE,
  workplace_id UUID NOT NULL REFERENCES gw_workplaces(id) ON DELETE RESTRICT,
  assignment_type TEXT NOT NULL DEFAULT 'primary'
    CHECK (assignment_type IN ('primary', 'secondary', 'cost_allocation', 'temporary')),
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  source_document_id UUID,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_employee_workplace_assignments_employee
  ON gw_employee_workplace_assignments(employee_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS gw_labor_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_root TEXT NOT NULL,
  target_attendance_month DATE,
  target_payroll_month DATE,
  period_start DATE,
  period_end DATE,
  pay_date DATE,
  status TEXT NOT NULL DEFAULT 'imported'
    CHECK (status IN ('draft', 'imported', 'reviewing', 'locked', 'voided')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gw_labor_source_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID REFERENCES gw_labor_import_batches(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'unknown',
  target_attendance_month DATE,
  target_payroll_month DATE,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'extracted', 'partial', 'image_only', 'failed')),
  extraction_notes TEXT,
  extracted_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sha256)
);

CREATE INDEX IF NOT EXISTS idx_gw_labor_source_documents_batch
  ON gw_labor_source_documents(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_gw_labor_source_documents_type
  ON gw_labor_source_documents(document_type);

CREATE TABLE IF NOT EXISTS gw_labor_source_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id UUID NOT NULL REFERENCES gw_labor_source_documents(id) ON DELETE CASCADE,
  row_kind TEXT NOT NULL DEFAULT 'row',
  employee_id UUID REFERENCES gw_payroll_employees(id) ON DELETE SET NULL,
  user_id UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  match_confidence NUMERIC(5,2),
  sheet_name TEXT,
  page_number INTEGER,
  row_index INTEGER NOT NULL DEFAULT 0,
  row_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_labor_source_rows_document
  ON gw_labor_source_rows(source_document_id, row_kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_labor_source_rows_unique
  ON gw_labor_source_rows(source_document_id, row_kind, COALESCE(sheet_name, ''), COALESCE(page_number, -1), row_index);

CREATE TABLE IF NOT EXISTS gw_attendance_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_month DATE NOT NULL UNIQUE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  cutoff_day INTEGER NOT NULL DEFAULT 31,
  rounding_unit_minutes INTEGER NOT NULL DEFAULT 15,
  break_rule_set TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewing', 'locked', 'voided')),
  locked_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gw_payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_month DATE NOT NULL UNIQUE,
  attendance_period_id UUID REFERENCES gw_attendance_periods(id) ON DELETE SET NULL,
  attendance_month DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  pay_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'attendance_locked', 'calculated', 'approved', 'paid', 'locked', 'voided')),
  created_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_payroll_periods_attendance
  ON gw_payroll_periods(attendance_month);

CREATE TABLE IF NOT EXISTS gw_break_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  min_work_minutes_exclusive INTEGER NOT NULL DEFAULT -1,
  max_work_minutes_inclusive INTEGER,
  break_minutes INTEGER NOT NULL,
  rule_type TEXT NOT NULL DEFAULT 'company' CHECK (rule_type IN ('company', 'legal')),
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  UNIQUE (rule_set, min_work_minutes_exclusive, max_work_minutes_inclusive, effective_from)
);

INSERT INTO gw_break_rules (rule_set, name, min_work_minutes_exclusive, max_work_minutes_inclusive, break_minutes, rule_type, sort_order)
VALUES
  ('default', '5時間以下: 休憩なし', -1, 300, 0, 'company', 10),
  ('default', '5時間超-6時間以下: 30分', 300, 360, 30, 'company', 20),
  ('default', '6時間超-8時間以下: 45分', 360, 480, 45, 'legal', 30),
  ('default', '8時間超: 60分', 480, 999999, 60, 'legal', 40)
ON CONFLICT (rule_set, min_work_minutes_exclusive, max_work_minutes_inclusive, effective_from) DO UPDATE SET
  name = EXCLUDED.name,
  break_minutes = EXCLUDED.break_minutes,
  rule_type = EXCLUDED.rule_type,
  sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS gw_attendance_rounding_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  rounding_unit_minutes INTEGER NOT NULL DEFAULT 15,
  clock_in_method TEXT NOT NULL DEFAULT 'nearest'
    CHECK (clock_in_method IN ('none', 'floor', 'ceil', 'nearest')),
  clock_out_method TEXT NOT NULL DEFAULT 'nearest'
    CHECK (clock_out_method IN ('none', 'floor', 'ceil', 'nearest')),
  total_minutes_method TEXT NOT NULL DEFAULT 'nearest'
    CHECK (total_minutes_method IN ('none', 'floor', 'ceil', 'nearest')),
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  UNIQUE (rule_set, effective_from)
);

INSERT INTO gw_attendance_rounding_rules (rule_set, name, rounding_unit_minutes, clock_in_method, clock_out_method, total_minutes_method)
VALUES ('default', '15分丸め', 15, 'nearest', 'nearest', 'nearest')
ON CONFLICT (rule_set, effective_from) DO UPDATE SET
  name = EXCLUDED.name,
  rounding_unit_minutes = EXCLUDED.rounding_unit_minutes,
  clock_in_method = EXCLUDED.clock_in_method,
  clock_out_method = EXCLUDED.clock_out_method,
  total_minutes_method = EXCLUDED.total_minutes_method;

CREATE TABLE IF NOT EXISTS gw_holidays (
  holiday_date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  holiday_type TEXT NOT NULL DEFAULT 'national'
    CHECK (holiday_type IN ('national', 'company', 'legal_holiday', 'closed_day', 'other')),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gw_attendance_punches
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES gw_payroll_employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL;

ALTER TABLE gw_attendance_devices
  ADD COLUMN IF NOT EXISTS workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL;

UPDATE gw_attendance_devices device
SET workplace_id = workplace.id,
    updated_at = now()
FROM gw_workplaces workplace
WHERE device.workplace_id IS NULL
  AND (
    (device.code = 'hq' AND workplace.code = 'hq')
    OR (device.code = 'michinoeki' AND workplace.code = 'michinoeki')
  );

INSERT INTO gw_payroll_employees (
  user_id,
  display_name,
  real_name,
  department,
  default_workplace_id,
  source_key,
  raw_payload
)
SELECT
  users.id,
  COALESCE(users.real_name, users.display_name),
  users.real_name,
  users.department,
  workplaces.id,
  'gw_users:' || users.id::text,
  jsonb_build_object('source', 'gw_users', 'line_user_id', users.line_user_id)
FROM gw_users users
LEFT JOIN gw_workplaces workplaces
  ON (
    (users.department = 'フロア' AND workplaces.code = 'aizu_brandhall')
    OR (users.department = '道の駅' AND workplaces.code = 'michinoeki')
    OR (users.department = '製造' AND workplaces.code = 'hq')
  )
WHERE users.status = 'approved'
  AND NOT EXISTS (
    SELECT 1
    FROM gw_payroll_employees employees
    WHERE employees.user_id = users.id
  );

UPDATE gw_attendance_punches punches
SET employee_id = employees.id
FROM gw_payroll_employees employees
WHERE punches.employee_id IS NULL
  AND punches.user_id = employees.user_id;

ALTER TABLE gw_attendance_punches
  ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_attendance_punches'
      AND constraint_name = 'gw_attendance_punches_user_id_fkey'
  ) THEN
    ALTER TABLE gw_attendance_punches DROP CONSTRAINT gw_attendance_punches_user_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_attendance_punches'
      AND constraint_name = 'gw_attendance_punches_user_id_fkey'
  ) THEN
    ALTER TABLE gw_attendance_punches
      ADD CONSTRAINT gw_attendance_punches_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES gw_users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_attendance_punches'
      AND constraint_name = 'gw_attendance_punches_user_or_employee_check'
  ) THEN
    ALTER TABLE gw_attendance_punches
      ADD CONSTRAINT gw_attendance_punches_user_or_employee_check
      CHECK (user_id IS NOT NULL OR employee_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_employee_date
  ON gw_attendance_punches(employee_id, work_date, punched_at);
CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_workplace_date
  ON gw_attendance_punches(workplace_id, work_date, punched_at);

CREATE TABLE IF NOT EXISTS gw_attendance_daily_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_period_id UUID REFERENCES gw_attendance_periods(id) ON DELETE SET NULL,
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  work_date DATE NOT NULL,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'punch'
    CHECK (source_type IN ('punch', 'admin', 'import', 'manual')),
  clock_in_at TIMESTAMPTZ,
  clock_out_at TIMESTAMPTZ,
  rounded_clock_in_at TIMESTAMPTZ,
  rounded_clock_out_at TIMESTAMPTZ,
  gross_work_minutes INTEGER NOT NULL DEFAULT 0,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  net_work_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  night_minutes INTEGER NOT NULL DEFAULT 0,
  holiday_minutes INTEGER NOT NULL DEFAULT 0,
  legal_holiday_minutes INTEGER NOT NULL DEFAULT 0,
  weekday_saturday_overtime_minutes INTEGER NOT NULL DEFAULT 0,
  sunday_overtime_minutes INTEGER NOT NULL DEFAULT 0,
  weekend_holiday_minutes INTEGER NOT NULL DEFAULT 0,
  training_minutes INTEGER NOT NULL DEFAULT 0,
  retroactive_minutes INTEGER NOT NULL DEFAULT 0,
  early_late_count INTEGER NOT NULL DEFAULT 0,
  early_late_minutes INTEGER NOT NULL DEFAULT 0,
  commute_distance_km NUMERIC(8,2),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewing', 'approved', 'locked', 'voided')),
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  memo TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_daily_records_period
  ON gw_attendance_daily_records(attendance_period_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_gw_attendance_daily_records_date
  ON gw_attendance_daily_records(work_date, employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_attendance_daily_records_unique
  ON gw_attendance_daily_records(employee_id, work_date, COALESCE(workplace_id, '00000000-0000-0000-0000-000000000000'::uuid), source_type);

CREATE TABLE IF NOT EXISTS gw_attendance_monthly_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_period_id UUID NOT NULL REFERENCES gw_attendance_periods(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE RESTRICT,
  work_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  holiday_work_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  compensatory_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  paid_leave_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  special_leave_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  absence_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_work_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  night_minutes INTEGER NOT NULL DEFAULT 0,
  holiday_minutes INTEGER NOT NULL DEFAULT 0,
  legal_holiday_minutes INTEGER NOT NULL DEFAULT 0,
  weekday_saturday_overtime_minutes INTEGER NOT NULL DEFAULT 0,
  sunday_overtime_minutes INTEGER NOT NULL DEFAULT 0,
  weekend_holiday_minutes INTEGER NOT NULL DEFAULT 0,
  over_60h_overtime_minutes INTEGER NOT NULL DEFAULT 0,
  training_minutes INTEGER NOT NULL DEFAULT 0,
  retroactive_minutes INTEGER NOT NULL DEFAULT 0,
  early_late_count INTEGER NOT NULL DEFAULT 0,
  early_late_minutes INTEGER NOT NULL DEFAULT 0,
  workplace_minutes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewing', 'approved', 'locked', 'voided')),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attendance_period_id, employee_id)
);

CREATE TABLE IF NOT EXISTS gw_pay_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE CASCADE,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  rate_type TEXT NOT NULL CHECK (rate_type IN ('hourly', 'monthly_base', 'daily', 'allowance')),
  amount NUMERIC(12,2) NOT NULL,
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  note TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, workplace_id, rate_type, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_gw_pay_rates_employee
  ON gw_pay_rates(employee_id, effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_pay_rates_null_workplace_unique
  ON gw_pay_rates(employee_id, rate_type, effective_from)
  WHERE workplace_id IS NULL;

CREATE TABLE IF NOT EXISTS gw_employee_payroll_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  tax_table_category TEXT,
  dependents_count INTEGER,
  resident_tax_monthly_amount NUMERIC(12,2),
  employment_insurance_enabled BOOLEAN,
  social_insurance_enabled BOOLEAN,
  care_insurance_enabled BOOLEAN,
  standard_monthly_remuneration NUMERIC(12,2),
  payment_method TEXT CHECK (payment_method IN ('bank_transfer', 'cash', 'mixed')),
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  note TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS gw_commute_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE CASCADE,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  route_type TEXT NOT NULL DEFAULT 'commute'
    CHECK (route_type IN ('commute', 'business', 'regular', 'exception')),
  one_way_distance_km NUMERIC(8,2),
  round_trip_multiplier NUMERIC(5,2) NOT NULL DEFAULT 2,
  yen_per_km NUMERIC(8,2) NOT NULL DEFAULT 16,
  tax_free_limit NUMERIC(12,2),
  monthly_cap NUMERIC(12,2) NOT NULL DEFAULT 10000,
  effective_from DATE NOT NULL DEFAULT '1900-01-01',
  effective_to DATE,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  note TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, workplace_id, route_type, effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_commute_routes_null_workplace_unique
  ON gw_commute_routes(employee_id, route_type, effective_from)
  WHERE workplace_id IS NULL;

CREATE TABLE IF NOT EXISTS gw_commute_monthly_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id UUID NOT NULL REFERENCES gw_payroll_periods(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE RESTRICT,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  work_days NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_free_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_commute_monthly_results_unique
  ON gw_commute_monthly_results(payroll_period_id, employee_id, COALESCE(workplace_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS gw_payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('earning', 'deduction', 'attendance', 'company_contribution', 'memo')),
  taxable BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gw_payroll_items (code, name, item_type, taxable, sort_order)
VALUES
  ('base_salary', '基本給', 'earning', true, 10),
  ('regular_salary', '本給', 'earning', true, 20),
  ('weekend_holiday_allowance', '土日祝勤手当', 'earning', true, 30),
  ('special_allowance', '特別手当', 'earning', true, 40),
  ('skill_allowance', '技能手当', 'earning', true, 50),
  ('housing_allowance', '住宅手当', 'earning', true, 60),
  ('childcare_allowance', '育児手当', 'earning', true, 70),
  ('taxable_commute', '課税通勤手当', 'earning', true, 80),
  ('overtime_allowance', '超過勤務手当', 'earning', true, 90),
  ('regular_overtime', '普通残業', 'earning', true, 100),
  ('retroactive_allowance', '遡及手当', 'earning', true, 110),
  ('night_allowance', '深夜手当', 'earning', true, 120),
  ('holiday_work_allowance', '休日出勤手当', 'earning', true, 130),
  ('base_salary_2', '基本給2', 'earning', true, 140),
  ('gw_special_allowance', 'GW特別手当', 'earning', true, 150),
  ('paid_leave_buyout', '有給買取手当', 'earning', true, 160),
  ('absence_deduction', '欠勤控除', 'earning', true, 170),
  ('late_early_deduction', '遅早控除', 'earning', true, 180),
  ('obon_special_allowance', 'お盆特別手当', 'earning', true, 190),
  ('covid_leave_allowance', 'コロナ休業手当', 'earning', true, 200),
  ('weekday_saturday_overtime', '平日土曜残業', 'earning', true, 210),
  ('sunday_overtime', '日曜残業', 'earning', true, 220),
  ('over_60h_overtime', '月60時間超手当', 'earning', true, 230),
  ('solatium', '慰労金', 'earning', true, 240),
  ('non_taxable_commute', '非課税通勤手当', 'earning', false, 250),
  ('dismissal_notice_allowance', '解雇予告手当', 'earning', false, 260),
  ('health_insurance', '健康保険', 'deduction', false, 310),
  ('care_insurance', '介護保険', 'deduction', false, 320),
  ('child_childcare_contribution', '子ども子育て支援金', 'deduction', false, 330),
  ('welfare_pension', '厚生年金', 'deduction', false, 340),
  ('employment_insurance', '雇用保険', 'deduction', false, 350),
  ('insurance_adjustment', '調整保険', 'deduction', false, 360),
  ('income_tax', '所得税', 'deduction', false, 370),
  ('resident_tax', '住民税', 'deduction', false, 380),
  ('company_housing_rent', '社宅家賃', 'deduction', false, 390),
  ('year_end_adjustment', '年調精算額', 'deduction', false, 400),
  ('other_deduction', 'その他控除', 'deduction', false, 410)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  item_type = EXCLUDED.item_type,
  taxable = EXCLUDED.taxable,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE TABLE IF NOT EXISTS gw_payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id UUID NOT NULL REFERENCES gw_payroll_periods(id) ON DELETE CASCADE,
  source_import_batch_id UUID REFERENCES gw_labor_import_batches(id) ON DELETE SET NULL,
  run_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'calculated', 'approved', 'locked', 'voided')),
  calculation_mode TEXT NOT NULL DEFAULT 'imported'
    CHECK (calculation_mode IN ('imported', 'manual', 'calculated')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_period_id, run_number)
);

CREATE TABLE IF NOT EXISTS gw_payroll_employee_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID NOT NULL REFERENCES gw_payroll_runs(id) ON DELETE CASCADE,
  payroll_period_id UUID NOT NULL REFERENCES gw_payroll_periods(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE RESTRICT,
  attendance_summary_id UUID REFERENCES gw_attendance_monthly_summaries(id) ON DELETE SET NULL,
  taxable_payment_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  non_taxable_payment_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  social_insurance_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  deduction_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_income NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_payment NUMERIC(12,2) NOT NULL DEFAULT 0,
  cash_payment NUMERIC(12,2) NOT NULL DEFAULT 0,
  transfer_payment NUMERIC(12,2) NOT NULL DEFAULT 0,
  dependents_count INTEGER,
  tax_table_category TEXT,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id)
);

CREATE TABLE IF NOT EXISTS gw_payroll_result_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_result_id UUID NOT NULL REFERENCES gw_payroll_employee_results(id) ON DELETE CASCADE,
  payroll_item_id UUID NOT NULL REFERENCES gw_payroll_items(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  minutes INTEGER,
  days NUMERIC(8,2),
  rate NUMERIC(12,2),
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_result_id, payroll_item_id)
);

CREATE TABLE IF NOT EXISTS gw_employer_insurance_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id UUID NOT NULL REFERENCES gw_payroll_periods(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES gw_payroll_employees(id) ON DELETE SET NULL,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  health_insurance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  care_insurance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  welfare_pension_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  employment_insurance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  child_childcare_contribution_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gw_payroll_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id UUID REFERENCES gw_payroll_periods(id) ON DELETE SET NULL,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  checklist_type TEXT NOT NULL DEFAULT 'payroll_calculation',
  input_date DATE,
  input_by TEXT,
  confirmed_date DATE,
  confirmed_by TEXT,
  target_employee_count INTEGER,
  calculated_employee_count INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewing', 'confirmed', 'locked')),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gw_payroll_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL REFERENCES gw_payroll_checklists(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_label TEXT NOT NULL,
  item_value TEXT,
  checked BOOLEAN,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gw_payroll_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_period_id UUID NOT NULL REFERENCES gw_payroll_periods(id) ON DELETE CASCADE,
  workplace_id UUID REFERENCES gw_workplaces(id) ON DELETE SET NULL,
  allocation_key TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT,
  source_document_id UUID REFERENCES gw_labor_source_documents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_period_id, workplace_id, allocation_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_payroll_cost_allocations_null_workplace_unique
  ON gw_payroll_cost_allocations(payroll_period_id, allocation_key)
  WHERE workplace_id IS NULL;

CREATE TABLE IF NOT EXISTS gw_attendance_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_record_id UUID REFERENCES gw_attendance_daily_records(id) ON DELETE SET NULL,
  punch_id UUID REFERENCES gw_attendance_punches(id) ON DELETE SET NULL,
  employee_id UUID REFERENCES gw_payroll_employees(id) ON DELETE SET NULL,
  correction_type TEXT NOT NULL DEFAULT 'admin_edit'
    CHECK (correction_type IN ('admin_edit', 'employee_request', 'import_adjustment', 'void')),
  reason TEXT,
  before_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('requested', 'approved', 'rejected', 'voided')),
  requested_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gw_workplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_feature_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_employee_workplace_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_labor_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_labor_source_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_labor_source_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_attendance_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_break_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_attendance_rounding_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_attendance_daily_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_attendance_monthly_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_pay_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_employee_payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_commute_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_commute_monthly_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_employee_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_result_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_employer_insurance_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_payroll_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_attendance_corrections ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE
  gw_workplaces,
  gw_feature_roles,
  gw_payroll_employees,
  gw_employee_workplace_assignments,
  gw_labor_import_batches,
  gw_labor_source_documents,
  gw_labor_source_rows,
  gw_attendance_periods,
  gw_payroll_periods,
  gw_break_rules,
  gw_attendance_rounding_rules,
  gw_holidays,
  gw_attendance_daily_records,
  gw_attendance_monthly_summaries,
  gw_pay_rates,
  gw_employee_payroll_settings,
  gw_commute_routes,
  gw_commute_monthly_results,
  gw_payroll_items,
  gw_payroll_runs,
  gw_payroll_employee_results,
  gw_payroll_result_items,
  gw_employer_insurance_costs,
  gw_payroll_checklists,
  gw_payroll_checklist_items,
  gw_payroll_cost_allocations,
  gw_attendance_corrections
TO service_role;

COMMENT ON TABLE gw_payroll_employees IS 'Payroll employee master linked optionally to TSG gw_users.';
COMMENT ON TABLE gw_labor_source_rows IS 'Structured extracted rows from labor office PDFs/Excel files for audit and re-import.';
COMMENT ON TABLE gw_attendance_daily_records IS 'Payroll-ready daily attendance records generated from punches, import, or admin correction.';
COMMENT ON TABLE gw_attendance_monthly_summaries IS 'Monthly attendance summary used as payroll calculation input.';

NOTIFY pgrst, 'reload schema';
