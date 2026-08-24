create table if not exists public.gw_shift_periods (
  id uuid primary key default gen_random_uuid(),
  department text not null check (department in ('フロア', '製造', '道の駅')),
  title text not null,
  start_date date not null,
  end_date date not null,
  request_deadline date,
  status text not null default 'draft' check (status in ('draft', 'collecting', 'generated', 'editing', 'confirmed', 'exported', 'archived')),
  notes text,
  created_by uuid references public.gw_users(id) on delete set null,
  confirmed_by uuid references public.gw_users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_shift_periods_date_order check (end_date >= start_date),
  constraint gw_shift_periods_max_span check (end_date <= start_date + interval '90 days')
);

create table if not exists public.gw_shift_patterns (
  id uuid primary key default gen_random_uuid(),
  department text not null check (department in ('フロア', '製造', '道の駅')),
  label text not null,
  start_time time,
  end_time time,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  work_minutes integer check (work_minutes >= 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department, label)
);

create table if not exists public.gw_shift_requirements (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  work_date date not null,
  required_count numeric(4,1),
  workplace_label text,
  notes text,
  notes2 text,
  notes3 text,
  production_plan text,
  timee_count numeric(4,1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, work_date)
);

create table if not exists public.gw_shift_requests (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  work_date date not null,
  request_type text not null check (request_type in ('day_off', 'unavailable', 'available', 'time_preference', 'note')),
  priority text not null default 'must' check (priority in ('must', 'prefer', 'ok')),
  start_time time,
  end_time time,
  memo text,
  status text not null default 'submitted' check (status in ('submitted', 'reviewed', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, user_id, work_date)
);

create table if not exists public.gw_shift_assignments (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  user_id uuid references public.gw_users(id) on delete cascade,
  employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  work_date date not null,
  pattern_id uuid references public.gw_shift_patterns(id) on delete set null,
  shift_label text,
  start_time time,
  end_time time,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  work_minutes integer check (work_minutes >= 0),
  assignment_type text not null default 'staff' check (assignment_type in ('staff', 'timee', 'note')),
  note text,
  source text not null default 'manual' check (source in ('manual', 'ai', 'import')),
  created_by uuid references public.gw_users(id) on delete set null,
  updated_by uuid references public.gw_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, user_id, work_date)
);

create table if not exists public.gw_shift_generation_runs (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  status text not null default 'completed' check (status in ('completed', 'failed')),
  prompt jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_by uuid references public.gw_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_shift_periods_department_dates
  on public.gw_shift_periods (department, start_date desc, end_date desc);

create index if not exists idx_gw_shift_requirements_period_date
  on public.gw_shift_requirements (period_id, work_date);

create index if not exists idx_gw_shift_requests_period_user
  on public.gw_shift_requests (period_id, user_id, work_date);

create index if not exists idx_gw_shift_assignments_period_date
  on public.gw_shift_assignments (period_id, work_date);

alter table public.gw_shift_periods enable row level security;
alter table public.gw_shift_patterns enable row level security;
alter table public.gw_shift_requirements enable row level security;
alter table public.gw_shift_requests enable row level security;
alter table public.gw_shift_assignments enable row level security;
alter table public.gw_shift_generation_runs enable row level security;

grant all on public.gw_shift_periods to service_role;
grant all on public.gw_shift_patterns to service_role;
grant all on public.gw_shift_requirements to service_role;
grant all on public.gw_shift_requests to service_role;
grant all on public.gw_shift_assignments to service_role;
grant all on public.gw_shift_generation_runs to service_role;

insert into public.gw_shift_patterns (department, label, start_time, end_time, break_minutes, work_minutes, sort_order)
values
  ('フロア', 'フロア勤務', '09:00', '18:00', 60, 480, 10),
  ('フロア', '基本勤務', '09:00', '18:00', 60, 480, 20),
  ('フロア', '基本勤務＋フロア補助', '09:00', '18:00', 60, 480, 30),
  ('フロア', '基本勤務＋外勤', '09:00', '18:00', 60, 480, 40),
  ('フロア', '外勤', null, null, 0, null, 50),
  ('フロア', '早9:30-16:00(6)', '09:30', '16:00', 30, 360, 60),
  ('フロア', '遅10:00-16:30(6)', '10:00', '16:30', 30, 360, 70),
  ('フロア', '撮影対応', null, null, 0, null, 80),
  ('フロア', '午前中', null, null, 0, null, 90),
  ('フロア', '午後〜', null, null, 0, null, 100),
  ('フロア', '9:30〜13:00まで', '09:30', '13:00', 0, 210, 110),
  ('フロア', '14:30まで', null, '14:30', 0, null, 120),
  ('フロア', '15:00まで', null, '15:00', 0, null, 130),
  ('フロア', '8:30〜17:30(8)', '08:30', '17:30', 60, 480, 140),
  ('フロア', '9:00〜18:00(8)', '09:00', '18:00', 60, 480, 150),
  ('フロア', '研修参加', null, null, 0, null, 160),
  ('製造', '基本勤務', '08:30', '17:30', 60, 480, 10),
  ('製造', '8:00〜12:30', '08:00', '12:30', 0, 270, 20),
  ('製造', '8:30〜17:30(8)', '08:30', '17:30', 60, 480, 30),
  ('製造', '10:30〜15:30(1人)', '10:30', '15:30', 0, 300, 40),
  ('製造', '9:00〜15:30(6)', '09:00', '15:30', 30, 360, 50),
  ('製造', '9:00〜14:30(5)', '09:00', '14:30', 30, 300, 60),
  ('製造', '9:00〜12:00(3)', '09:00', '12:00', 0, 180, 70),
  ('製造', '8:30〜16:15(7)', '08:30', '16:15', 45, 420, 80),
  ('製造', '夜製造13:00〜21:30', '13:00', '21:30', 60, 450, 90),
  ('製造', '8:30〜12:00(3.5)', '08:30', '12:00', 0, 210, 100),
  ('製造', '12:00〜', '12:00', null, 0, null, 110),
  ('道の駅', '基本勤務', '08:30', '16:00', 60, 390, 10),
  ('道の駅', '8:30-16:00', '08:30', '16:00', 60, 390, 20),
  ('道の駅', '8:30-14:00', '08:30', '14:00', 30, 300, 30),
  ('道の駅', '8:00-12:00', '08:00', '12:00', 0, 240, 40),
  ('道の駅', '10:00-16:00', '10:00', '16:00', 30, 330, 50),
  ('道の駅', '11:00-15:30', '11:00', '15:30', 0, 270, 60),
  ('道の駅', '11:30-15:30', '11:30', '15:30', 0, 240, 70),
  ('道の駅', '11:30-16:30', '11:30', '16:30', 0, 300, 80),
  ('道の駅', '11:00-16:00', '11:00', '16:00', 0, 300, 90),
  ('道の駅', '8:00-13:00', '08:00', '13:00', 0, 300, 100),
  ('道の駅', '10:00-15:00', '10:00', '15:00', 0, 300, 110),
  ('道の駅', '13:00-16:30', '13:00', '16:30', 0, 210, 120),
  ('道の駅', '11:00-14:00', '11:00', '14:00', 0, 180, 130),
  ('道の駅', '12:00-15:00', '12:00', '15:00', 0, 180, 140),
  ('道の駅', '11:00-15:00', '11:00', '15:00', 0, 240, 150),
  ('道の駅', '10:00-14:00', '10:00', '14:00', 0, 240, 160),
  ('道の駅', '10:30-15:30', '10:30', '15:30', 0, 300, 170),
  ('道の駅', '10:30-14:00', '10:30', '14:00', 0, 210, 175)
on conflict (department, label) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    break_minutes = excluded.break_minutes,
    work_minutes = excluded.work_minutes,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();
