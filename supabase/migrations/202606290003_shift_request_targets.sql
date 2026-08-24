create table if not exists public.gw_shift_request_targets (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  requested_by uuid references public.gw_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, user_id)
);

create index if not exists idx_gw_shift_request_targets_period_user
  on public.gw_shift_request_targets (period_id, user_id);

alter table public.gw_shift_request_targets enable row level security;

grant all on public.gw_shift_request_targets to service_role;
