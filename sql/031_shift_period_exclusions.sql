create table if not exists public.gw_shift_period_exclusions (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  excluded_by uuid references public.gw_users(id) on delete set null,
  excluded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (period_id, user_id)
);

create index if not exists idx_gw_shift_period_exclusions_period_user
  on public.gw_shift_period_exclusions (period_id, user_id);

alter table public.gw_shift_period_exclusions enable row level security;

grant all on public.gw_shift_period_exclusions to service_role;
