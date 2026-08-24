create table if not exists public.gw_shift_pattern_preferences (
  id uuid primary key default gen_random_uuid(),
  department text not null check (department in ('フロア', '製造', '道の駅')),
  employee_id uuid references public.gw_payroll_employees(id) on delete cascade,
  user_id uuid references public.gw_users(id) on delete cascade,
  employee_code text,
  employee_name text not null,
  pattern_label text not null,
  weight integer not null default 1 check (weight > 0),
  sort_order integer not null default 0,
  source text not null default 'manual',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department, employee_name, pattern_label)
);

create index if not exists idx_gw_shift_pattern_preferences_department
  on public.gw_shift_pattern_preferences (department, employee_code, employee_name);

alter table public.gw_shift_pattern_preferences enable row level security;
grant all on public.gw_shift_pattern_preferences to service_role;

insert into public.gw_shift_patterns (department, label, start_time, end_time, break_minutes, work_minutes, sort_order)
values
  ('道の駅', '10:30-14:00', '10:30', '14:00', 0, 210, 175)
on conflict (department, label) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    break_minutes = excluded.break_minutes,
    work_minutes = excluded.work_minutes,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();

insert into public.gw_shift_pattern_preferences
  (department, employee_code, employee_name, pattern_label, weight, sort_order, source, notes)
values
  ('道の駅', '1', '佐藤正彦', '11:00-14:00', 5, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 社長列'),
  ('道の駅', '2', '佐藤ちさと', '基本勤務', 25, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 佐藤列'),
  ('道の駅', '107', '武藤志保', '基本勤務', 23, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 武藤列'),
  ('道の駅', '138', '角田聖子', '11:00-14:00', 15, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 角田列'),
  ('道の駅', '138', '角田聖子', '11:00-15:00', 4, 20, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 角田列'),
  ('道の駅', null, '生井美穂', '11:00-15:00', 11, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列'),
  ('道の駅', null, '生井美穂', '8:30-16:00', 7, 20, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列'),
  ('道の駅', null, '生井美穂', '11:00-15:30', 2, 30, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列'),
  ('道の駅', null, '生井美穂', '10:00-15:00', 2, 40, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列'),
  ('道の駅', null, '生井美穂', '10:30-14:00', 1, 50, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列'),
  ('道の駅', null, '内海美穂', '11:00-15:00', 11, 10, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列の別名'),
  ('道の駅', null, '内海美穂', '8:30-16:00', 7, 20, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列の別名'),
  ('道の駅', null, '内海美穂', '11:00-15:30', 2, 30, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列の別名'),
  ('道の駅', null, '内海美穂', '10:00-15:00', 2, 40, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列の別名'),
  ('道の駅', null, '内海美穂', '10:30-14:00', 1, 50, 'shift_excel_2026_06', 'シフト表.xlsx 2026年6月: 生井列の別名')
on conflict (department, employee_name, pattern_label) do update
set employee_code = excluded.employee_code,
    weight = excluded.weight,
    sort_order = excluded.sort_order,
    source = excluded.source,
    notes = excluded.notes,
    updated_at = now();
