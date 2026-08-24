begin;

create table if not exists public.gw_bereavement_leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid not null references public.gw_users(id) on delete restrict,
  relationship_code text not null check (
    relationship_code in (
      'parent',
      'child',
      'grandparent',
      'grandchild',
      'sibling',
      'great_grandparent',
      'great_grandchild',
      'uncle_aunt',
      'nephew_niece'
    )
  ),
  relationship_label text not null,
  relationship_degree smallint not null check (relationship_degree between 1 and 3),
  entitled_days smallint not null check (entitled_days in (1, 3, 7)),
  leave_start_date date not null,
  leave_end_date date not null,
  requested_days smallint not null check (requested_days between 1 and 7),
  request_status text not null default 'submitted' check (
    request_status in ('submitted', 'approved', 'rejected', 'cancelled')
  ),
  employee_memo text,
  manager_memo text,
  requested_by uuid not null references public.gw_users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  approved_by uuid references public.gw_users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references public.gw_users(id) on delete set null,
  rejected_at timestamptz,
  cancelled_by uuid references public.gw_users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_bereavement_leave_date_order check (leave_end_date >= leave_start_date),
  constraint gw_bereavement_leave_policy_days check (
    (relationship_degree = 1 and entitled_days = 7) or
    (relationship_degree = 2 and entitled_days = 3) or
    (relationship_degree = 3 and entitled_days = 1)
  ),
  constraint gw_bereavement_leave_requested_days_limit check (requested_days <= entitled_days)
);

create index if not exists gw_bereavement_leave_employee_date_idx
  on public.gw_bereavement_leave_requests (employee_id, leave_start_date desc);

create index if not exists gw_bereavement_leave_status_idx
  on public.gw_bereavement_leave_requests (request_status, requested_at desc);

create unique index if not exists gw_bereavement_leave_active_period_uidx
  on public.gw_bereavement_leave_requests (employee_id, leave_start_date, leave_end_date)
  where request_status in ('submitted', 'approved');

alter table public.gw_bereavement_leave_requests enable row level security;

grant all on public.gw_bereavement_leave_requests to service_role;

comment on table public.gw_bereavement_leave_requests is
  'Company bereavement leave applications for regular employees. Entitlement is 7 days for first-degree, 3 days for second-degree, and 1 day for third-degree relatives.';

commit;
