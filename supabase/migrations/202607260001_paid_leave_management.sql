begin;

create table if not exists public.gw_paid_leave_profiles (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid references public.gw_users(id) on delete set null,
  grant_schedule_kind text not null default 'auto'
    check (grant_schedule_kind in ('auto', 'standard', 'proportional')),
  scheduled_week_days numeric(3,1)
    check (scheduled_week_days is null or scheduled_week_days between 1 and 7),
  scheduled_week_minutes integer
    check (scheduled_week_minutes is null or scheduled_week_minutes >= 0),
  annual_scheduled_days integer
    check (annual_scheduled_days is null or annual_scheduled_days >= 0),
  attendance_threshold numeric(5,4) not null default 0.8000
    check (attendance_threshold between 0 and 1),
  grant_when_equal_to_threshold boolean not null default true,
  assume_first_assessment_eligible boolean not null default true,
  wage_method text not null default 'ordinary_wage'
    check (wage_method in ('ordinary_wage', 'average_wage', 'standard_monthly_remuneration')),
  half_day_enabled boolean not null default true,
  last_grant_date date,
  next_grant_date date,
  projected_grant_days numeric(5,2)
    check (
      projected_grant_days is null
      or (
        projected_grant_days >= 0
        and projected_grant_days * 2 = trunc(projected_grant_days * 2)
      )
    ),
  projection_calculated_at timestamptz,
  notes text,
  created_by uuid references public.gw_users(id) on delete set null,
  updated_by uuid references public.gw_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id)
);

create unique index if not exists idx_gw_paid_leave_profiles_user
  on public.gw_paid_leave_profiles (user_id)
  where user_id is not null;

create index if not exists idx_gw_paid_leave_profiles_next_grant
  on public.gw_paid_leave_profiles (next_grant_date, employee_id);

do $$
declare
  previous_default text;
begin
  select columns.column_default
  into previous_default
  from information_schema.columns
  where columns.table_schema = 'public'
    and columns.table_name = 'gw_paid_leave_profiles'
    and columns.column_name = 'grant_when_equal_to_threshold';

  if previous_default in ('false', 'false::boolean') then
    update public.gw_paid_leave_profiles
    set grant_when_equal_to_threshold = true,
        updated_at = now()
    where not grant_when_equal_to_threshold;
  end if;
end
$$;

alter table public.gw_paid_leave_profiles
  alter column grant_when_equal_to_threshold set default true;

create table if not exists public.gw_paid_leave_grant_lots (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid references public.gw_users(id) on delete set null,
  grant_date date not null,
  expires_on date not null,
  granted_days numeric(5,2) not null default 0
    check (granted_days >= 0 and granted_days * 2 = trunc(granted_days * 2)),
  grant_source text not null
    check (
      grant_source in (
        'statutory_standard',
        'statutory_proportional',
        'initial_company_assumption',
        'manual_adjustment',
        'carryover_import'
      )
    ),
  grant_status text not null default 'granted'
    check (grant_status in ('granted', 'withheld', 'voided')),
  service_months integer check (service_months is null or service_months >= 0),
  scheduled_week_days numeric(3,1)
    check (scheduled_week_days is null or scheduled_week_days between 1 and 7),
  annual_scheduled_days integer
    check (annual_scheduled_days is null or annual_scheduled_days >= 0),
  attendance_reference_start date,
  attendance_reference_end date,
  attendance_numerator_days numeric(7,2)
    check (attendance_numerator_days is null or attendance_numerator_days >= 0),
  attendance_denominator_days numeric(7,2)
    check (attendance_denominator_days is null or attendance_denominator_days >= 0),
  attendance_rate numeric(7,6)
    check (attendance_rate is null or attendance_rate between 0 and 1),
  attendance_threshold numeric(5,4) not null default 0.8000
    check (attendance_threshold between 0 and 1),
  grant_when_equal_to_threshold boolean not null default true,
  initial_assumption boolean not null default false,
  source_key text,
  notes text,
  created_by uuid references public.gw_users(id) on delete set null,
  voided_by uuid references public.gw_users(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_paid_leave_grant_lots_expiry_check
    check (expires_on = (grant_date + interval '2 years')::date),
  constraint gw_paid_leave_grant_lots_reference_check
    check (
      attendance_reference_start is null
      or attendance_reference_end is null
      or attendance_reference_end >= attendance_reference_start
    ),
  constraint gw_paid_leave_grant_lots_status_days_check
    check (
      (grant_status = 'granted' and granted_days > 0)
      or (grant_status in ('withheld', 'voided'))
    ),
  constraint gw_paid_leave_grant_lots_initial_source_check
    check (
      not initial_assumption
      or grant_source = 'initial_company_assumption'
    )
);

create unique index if not exists idx_gw_paid_leave_grant_lots_statutory_unique
  on public.gw_paid_leave_grant_lots (employee_id, grant_date)
  where
    grant_status <> 'voided'
    and grant_source in (
      'statutory_standard',
      'statutory_proportional',
      'initial_company_assumption'
    );

create unique index if not exists idx_gw_paid_leave_grant_lots_source_key
  on public.gw_paid_leave_grant_lots (source_key)
  where source_key is not null;

create index if not exists idx_gw_paid_leave_grant_lots_employee_expiry
  on public.gw_paid_leave_grant_lots
  (employee_id, expires_on, grant_date)
  where grant_status = 'granted';

do $$
declare
  previous_default text;
begin
  select columns.column_default
  into previous_default
  from information_schema.columns
  where columns.table_schema = 'public'
    and columns.table_name = 'gw_paid_leave_grant_lots'
    and columns.column_name = 'grant_when_equal_to_threshold';

  if previous_default in ('false', 'false::boolean') then
    update public.gw_paid_leave_grant_lots
    set grant_when_equal_to_threshold = true,
        updated_at = now()
    where not grant_when_equal_to_threshold;
  end if;
end
$$;

alter table public.gw_paid_leave_grant_lots
  alter column grant_when_equal_to_threshold set default true;

create table if not exists public.gw_paid_leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid references public.gw_users(id) on delete set null,
  leave_date date not null,
  leave_unit text not null
    check (leave_unit in ('full_day', 'half_day', 'half_day_am', 'half_day_pm')),
  requested_days numeric(3,1) generated always as (
    case when leave_unit = 'full_day' then 1.0 else 0.5 end
  ) stored,
  request_source text not null default 'employee'
    check (
      request_source in (
        'shift_preference',
        'employee',
        'admin',
        'missing_punch_resolution',
        'import'
      )
    ),
  request_status text not null default 'submitted'
    check (
      request_status in (
        'draft',
        'submitted',
        'approved',
        'rejected',
        'cancelled',
        'consumed',
        'voided'
      )
    ),
  shift_period_id uuid references public.gw_shift_periods(id) on delete set null,
  shift_assignment_id uuid references public.gw_shift_assignments(id) on delete set null,
  scheduled_minutes_snapshot integer
    check (scheduled_minutes_snapshot is null or scheduled_minutes_snapshot >= 0),
  wage_method text not null default 'ordinary_wage'
    check (wage_method in ('ordinary_wage', 'average_wage', 'standard_monthly_remuneration')),
  hourly_rate_snapshot numeric(12,2)
    check (hourly_rate_snapshot is null or hourly_rate_snapshot >= 0),
  payable_minutes_snapshot integer
    check (payable_minutes_snapshot is null or payable_minutes_snapshot >= 0),
  paid_wage_amount numeric(12,2)
    check (paid_wage_amount is null or paid_wage_amount >= 0),
  requested_by uuid references public.gw_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  approved_by uuid references public.gw_users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references public.gw_users(id) on delete set null,
  rejected_at timestamptz,
  cancelled_by uuid references public.gw_users(id) on delete set null,
  cancelled_at timestamptz,
  employee_memo text,
  manager_memo text,
  source_key text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_paid_leave_requests_half_day_check
    check (
      leave_unit = 'full_day'
      or scheduled_minutes_snapshot is null
      or payable_minutes_snapshot is null
      or payable_minutes_snapshot <= scheduled_minutes_snapshot
    )
);

drop index if exists public.idx_gw_paid_leave_requests_employee_date_active;

create unique index idx_gw_paid_leave_requests_employee_date_active
  on public.gw_paid_leave_requests (employee_id, leave_date)
  where
    request_status not in ('rejected', 'cancelled', 'voided')
    and request_source <> 'import';

create unique index if not exists idx_gw_paid_leave_requests_source_key
  on public.gw_paid_leave_requests (source_key)
  where source_key is not null;

create index if not exists idx_gw_paid_leave_requests_user_date
  on public.gw_paid_leave_requests (user_id, leave_date desc)
  where user_id is not null;

create index if not exists idx_gw_paid_leave_requests_status_date
  on public.gw_paid_leave_requests (request_status, leave_date);

create table if not exists public.gw_workday_resolutions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid references public.gw_users(id) on delete set null,
  work_date date not null,
  shift_period_id uuid references public.gw_shift_periods(id) on delete set null,
  shift_assignment_id uuid references public.gw_shift_assignments(id) on delete set null,
  scheduled_minutes_snapshot integer
    check (scheduled_minutes_snapshot is null or scheduled_minutes_snapshot >= 0),
  resolution_type text not null default 'pending'
    check (
      resolution_type in (
        'pending',
        'punch_missing',
        'punch_correction',
        'paid_leave_full',
        'paid_leave_half',
        'absence',
        'work_schedule_changed',
        'employer_shutdown'
      )
    ),
  resolution_status text not null default 'pending'
    check (
      resolution_status in (
        'pending',
        'employee_answered',
        'admin_confirmed',
        'reopened',
        'voided'
      )
    ),
  paid_leave_request_id uuid references public.gw_paid_leave_requests(id) on delete set null,
  clock_in_punch_id uuid references public.gw_attendance_punches(id) on delete set null,
  clock_out_punch_id uuid references public.gw_attendance_punches(id) on delete set null,
  employee_answered_by uuid references public.gw_users(id) on delete set null,
  employee_answered_at timestamptz,
  confirmed_by uuid references public.gw_users(id) on delete set null,
  confirmed_at timestamptz,
  employee_memo text,
  manager_memo text,
  source_key text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_workday_resolutions_paid_leave_link_check
    check (
      resolution_type not in ('paid_leave_full', 'paid_leave_half')
      or paid_leave_request_id is not null
    )
);

create unique index if not exists idx_gw_workday_resolutions_employee_date_active
  on public.gw_workday_resolutions (employee_id, work_date)
  where resolution_status <> 'voided';

create unique index if not exists idx_gw_workday_resolutions_paid_leave_request
  on public.gw_workday_resolutions (paid_leave_request_id)
  where paid_leave_request_id is not null and resolution_status <> 'voided';

create unique index if not exists idx_gw_workday_resolutions_source_key
  on public.gw_workday_resolutions (source_key)
  where source_key is not null;

create index if not exists idx_gw_workday_resolutions_pending
  on public.gw_workday_resolutions (resolution_status, work_date, employee_id);

create table if not exists public.gw_paid_leave_consumption_allocations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.gw_paid_leave_requests(id) on delete restrict,
  grant_lot_id uuid not null references public.gw_paid_leave_grant_lots(id) on delete restrict,
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  allocated_days numeric(3,1) not null
    check (allocated_days > 0 and allocated_days * 2 = trunc(allocated_days * 2)),
  allocated_by uuid references public.gw_users(id) on delete set null,
  allocated_at timestamptz not null default now(),
  voided_by uuid references public.gw_users(id) on delete set null,
  voided_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (request_id, grant_lot_id)
);

create index if not exists idx_gw_paid_leave_allocations_lot
  on public.gw_paid_leave_consumption_allocations (grant_lot_id, allocated_at)
  where voided_at is null;

create index if not exists idx_gw_paid_leave_allocations_employee
  on public.gw_paid_leave_consumption_allocations (employee_id, allocated_at desc)
  where voided_at is null;

create table if not exists public.gw_paid_leave_average_snapshots (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_payroll_employees(id) on delete restrict,
  user_id uuid references public.gw_users(id) on delete set null,
  reference_start date not null,
  reference_end date not null,
  source_type text not null
    check (source_type in ('shift_workbook', 'confirmed_shifts', 'attendance_punches', 'payroll', 'admin')),
  calculation_purpose text not null default 'reference_display'
    check (calculation_purpose in ('reference_display', 'statutory_average_wage')),
  worked_days numeric(7,2) not null default 0 check (worked_days >= 0),
  worked_minutes integer not null default 0 check (worked_minutes >= 0),
  wage_total numeric(14,2) not null default 0 check (wage_total >= 0),
  average_minutes_per_worked_day integer
    check (average_minutes_per_worked_day is null or average_minutes_per_worked_day >= 0),
  average_wage_per_worked_day numeric(12,2)
    check (average_wage_per_worked_day is null or average_wage_per_worked_day >= 0),
  hourly_rate_snapshot numeric(12,2)
    check (hourly_rate_snapshot is null or hourly_rate_snapshot >= 0),
  is_reference_only boolean not null default true,
  source_key text,
  details jsonb not null default '{}'::jsonb,
  calculated_by uuid references public.gw_users(id) on delete set null,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint gw_paid_leave_average_snapshots_period_check
    check (reference_end >= reference_start),
  constraint gw_paid_leave_average_snapshots_purpose_check
    check (
      calculation_purpose <> 'reference_display'
      or is_reference_only
    )
);

create unique index if not exists idx_gw_paid_leave_average_snapshots_period
  on public.gw_paid_leave_average_snapshots
  (employee_id, reference_start, reference_end, source_type, calculation_purpose);

create unique index if not exists idx_gw_paid_leave_average_snapshots_source_key
  on public.gw_paid_leave_average_snapshots (source_key)
  where source_key is not null;

create index if not exists idx_gw_paid_leave_average_snapshots_employee
  on public.gw_paid_leave_average_snapshots (employee_id, reference_end desc);

create table if not exists public.gw_paid_leave_audit_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  user_id uuid references public.gw_users(id) on delete set null,
  entity_type text not null
    check (
      entity_type in (
        'profile',
        'grant_lot',
        'request',
        'workday_resolution',
        'consumption_allocation',
        'average_snapshot'
      )
    ),
  entity_id uuid not null,
  action text not null
    check (
      action in (
        'create',
        'update',
        'approve',
        'reject',
        'cancel',
        'consume',
        'allocate',
        'void',
        'resolve',
        'reopen',
        'import',
        'project'
      )
    ),
  actor_user_id uuid references public.gw_users(id) on delete set null,
  actor_type text not null default 'user'
    check (actor_type in ('user', 'system', 'import', 'service')),
  source text,
  before_payload jsonb not null default '{}'::jsonb,
  after_payload jsonb not null default '{}'::jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_paid_leave_audit_logs_entity
  on public.gw_paid_leave_audit_logs (entity_type, entity_id, created_at desc);

create index if not exists idx_gw_paid_leave_audit_logs_employee
  on public.gw_paid_leave_audit_logs (employee_id, created_at desc);

create table if not exists public.gw_proxy_view_audit_logs (
  id uuid primary key default gen_random_uuid(),
  viewer_user_id uuid not null references public.gw_users(id) on delete restrict,
  subject_user_id uuid not null references public.gw_users(id) on delete restrict,
  subject_employee_id uuid references public.gw_payroll_employees(id) on delete set null,
  screen_key text not null default 'paid_leave',
  viewed_at timestamptz not null default now(),
  request_id text,
  constraint gw_proxy_view_not_self check (viewer_user_id <> subject_user_id)
);

create index if not exists idx_gw_proxy_view_audit_logs_viewer
  on public.gw_proxy_view_audit_logs (viewer_user_id, viewed_at desc);

create index if not exists idx_gw_proxy_view_audit_logs_subject
  on public.gw_proxy_view_audit_logs (subject_user_id, viewed_at desc);

create or replace view public.gw_paid_leave_grant_balances as
select
  lots.id as grant_lot_id,
  lots.employee_id,
  lots.user_id,
  lots.grant_date,
  lots.expires_on,
  lots.granted_days,
  lots.grant_source,
  lots.initial_assumption,
  coalesce(sum(allocations.allocated_days) filter (where allocations.voided_at is null), 0)::numeric(5,2)
    as allocated_days,
  greatest(
    lots.granted_days
      - coalesce(sum(allocations.allocated_days) filter (where allocations.voided_at is null), 0),
    0
  )::numeric(5,2) as remaining_days,
  lots.expires_on <= current_date as expired
from public.gw_paid_leave_grant_lots lots
left join public.gw_paid_leave_consumption_allocations allocations
  on allocations.grant_lot_id = lots.id
where lots.grant_status = 'granted'
group by lots.id;

create or replace function public.gw_approve_paid_leave_request(
  p_request_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_request public.gw_paid_leave_requests%rowtype;
  target_lot public.gw_paid_leave_grant_lots%rowtype;
  requested_days numeric(5,2);
  remaining_days numeric(5,2);
  lot_remaining_days numeric(5,2);
  allocate_days numeric(5,2);
begin
  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '有給申請が見つかりません';
  end if;

  if target_request.request_status in ('rejected', 'cancelled', 'voided') then
    raise exception '取消・却下済みの有給申請は承認できません';
  end if;

  requested_days := target_request.requested_days;
  remaining_days := requested_days;

  delete from public.gw_paid_leave_consumption_allocations
  where request_id = target_request.id;

  for target_lot in
    select lots.*
    from public.gw_paid_leave_grant_lots lots
    where lots.employee_id = target_request.employee_id
      and lots.grant_status = 'granted'
      and lots.grant_date <= target_request.leave_date
      and lots.expires_on > target_request.leave_date
    order by lots.expires_on, lots.grant_date, lots.id
    for update
  loop
    select greatest(
      target_lot.granted_days - coalesce(sum(allocations.allocated_days), 0),
      0
    )
    into lot_remaining_days
    from public.gw_paid_leave_consumption_allocations allocations
    where allocations.grant_lot_id = target_lot.id
      and allocations.voided_at is null;

    if lot_remaining_days <= 0 then
      continue;
    end if;

    allocate_days := least(remaining_days, lot_remaining_days);
    insert into public.gw_paid_leave_consumption_allocations (
      request_id,
      grant_lot_id,
      employee_id,
      allocated_days,
      allocated_by
    )
    values (
      target_request.id,
      target_lot.id,
      target_request.employee_id,
      allocate_days,
      p_actor_user_id
    );

    remaining_days := remaining_days - allocate_days;
    exit when remaining_days <= 0;
  end loop;

  if remaining_days > 0 then
    raise exception '有給残日数が不足しています（不足 % 日）', remaining_days;
  end if;

  update public.gw_paid_leave_requests
  set request_status = 'approved',
      approved_by = p_actor_user_id,
      approved_at = coalesce(approved_at, now()),
      updated_at = now()
  where id = target_request.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id,
    user_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_type,
    source,
    after_payload
  )
  values (
    target_request.employee_id,
    target_request.user_id,
    'request',
    target_request.id,
    'approve',
    p_actor_user_id,
    'user',
    'gw_approve_paid_leave_request',
    jsonb_build_object('requested_days', requested_days)
  );

  return jsonb_build_object(
    'request_id', target_request.id,
    'allocated_days', requested_days,
    'status', 'approved'
  );
end;
$$;

create or replace function public.gw_confirm_workday_resolution(
  p_resolution_id uuid,
  p_actor_user_id uuid,
  p_manager_memo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_resolution public.gw_workday_resolutions%rowtype;
begin
  select *
  into target_resolution
  from public.gw_workday_resolutions
  where id = p_resolution_id
  for update;

  if not found then
    raise exception '未打刻回答が見つかりません';
  end if;

  if target_resolution.resolution_status not in ('employee_answered', 'reopened') then
    raise exception '確認待ちではない回答は確定できません';
  end if;

  if target_resolution.paid_leave_request_id is not null then
    perform public.gw_approve_paid_leave_request(
      target_resolution.paid_leave_request_id,
      p_actor_user_id
    );
  end if;

  update public.gw_workday_resolutions
  set resolution_status = 'admin_confirmed',
      confirmed_by = p_actor_user_id,
      confirmed_at = now(),
      manager_memo = nullif(btrim(coalesce(p_manager_memo, '')), ''),
      updated_at = now()
  where id = target_resolution.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id,
    user_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_type,
    source,
    after_payload
  )
  values (
    target_resolution.employee_id,
    target_resolution.user_id,
    'workday_resolution',
    target_resolution.id,
    'resolve',
    p_actor_user_id,
    'user',
    'gw_confirm_workday_resolution',
    jsonb_build_object(
      'resolution_type', target_resolution.resolution_type,
      'paid_leave_request_id', target_resolution.paid_leave_request_id
    )
  );

  return jsonb_build_object(
    'resolution_id', target_resolution.id,
    'status', 'admin_confirmed'
  );
end;
$$;

create or replace function public.gw_reject_paid_leave_request(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_manager_memo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_request public.gw_paid_leave_requests%rowtype;
begin
  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '有給申請が見つかりません';
  end if;

  if target_request.request_status = 'consumed' then
    raise exception '消化済みの有給申請は却下できません';
  end if;

  update public.gw_paid_leave_consumption_allocations
  set voided_by = p_actor_user_id,
      voided_at = now(),
      notes = 'request rejected'
  where request_id = target_request.id
    and voided_at is null;

  update public.gw_paid_leave_requests
  set request_status = 'rejected',
      rejected_by = p_actor_user_id,
      rejected_at = now(),
      manager_memo = nullif(btrim(coalesce(p_manager_memo, '')), ''),
      updated_at = now()
  where id = target_request.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id, user_id, entity_type, entity_id, action,
    actor_user_id, actor_type, source, after_payload
  )
  values (
    target_request.employee_id, target_request.user_id, 'request',
    target_request.id, 'reject', p_actor_user_id, 'user',
    'gw_reject_paid_leave_request',
    jsonb_build_object('previous_status', target_request.request_status)
  );

  return jsonb_build_object('request_id', target_request.id, 'status', 'rejected');
end;
$$;

create or replace function public.gw_reopen_workday_resolution(
  p_resolution_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_resolution public.gw_workday_resolutions%rowtype;
begin
  select *
  into target_resolution
  from public.gw_workday_resolutions
  where id = p_resolution_id
  for update;

  if not found then
    raise exception '未打刻回答が見つかりません';
  end if;

  if target_resolution.paid_leave_request_id is not null then
    update public.gw_paid_leave_consumption_allocations
    set voided_by = p_actor_user_id,
        voided_at = now(),
        notes = 'workday resolution reopened'
    where request_id = target_resolution.paid_leave_request_id
      and voided_at is null;

    update public.gw_paid_leave_requests
    set request_status = 'cancelled',
        cancelled_by = p_actor_user_id,
        cancelled_at = now(),
        updated_at = now()
    where id = target_resolution.paid_leave_request_id
      and request_status in ('draft', 'submitted', 'approved');
  end if;

  update public.gw_workday_resolutions
  set resolution_status = 'voided',
      confirmed_by = null,
      confirmed_at = null,
      updated_at = now()
  where id = target_resolution.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id, user_id, entity_type, entity_id, action,
    actor_user_id, actor_type, source, after_payload
  )
  values (
    target_resolution.employee_id, target_resolution.user_id,
    'workday_resolution', target_resolution.id, 'reopen',
    p_actor_user_id, 'user', 'gw_reopen_workday_resolution',
    jsonb_build_object('previous_status', target_resolution.resolution_status)
  );

  return jsonb_build_object('resolution_id', target_resolution.id, 'status', 'voided');
end;
$$;

create or replace function public.gw_create_and_approve_paid_leave_request(
  p_payload jsonb,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_request_id uuid;
begin
  insert into public.gw_paid_leave_requests (
    employee_id,
    user_id,
    leave_date,
    leave_unit,
    request_source,
    request_status,
    shift_period_id,
    shift_assignment_id,
    scheduled_minutes_snapshot,
    wage_method,
    hourly_rate_snapshot,
    payable_minutes_snapshot,
    paid_wage_amount,
    requested_by,
    manager_memo,
    source_key,
    raw_payload
  )
  values (
    (p_payload ->> 'employee_id')::uuid,
    nullif(p_payload ->> 'user_id', '')::uuid,
    (p_payload ->> 'leave_date')::date,
    p_payload ->> 'leave_unit',
    coalesce(nullif(p_payload ->> 'request_source', ''), 'admin'),
    'submitted',
    nullif(p_payload ->> 'shift_period_id', '')::uuid,
    nullif(p_payload ->> 'shift_assignment_id', '')::uuid,
    nullif(p_payload ->> 'scheduled_minutes_snapshot', '')::integer,
    coalesce(nullif(p_payload ->> 'wage_method', ''), 'ordinary_wage'),
    nullif(p_payload ->> 'hourly_rate_snapshot', '')::numeric,
    nullif(p_payload ->> 'payable_minutes_snapshot', '')::integer,
    nullif(p_payload ->> 'paid_wage_amount', '')::numeric,
    p_actor_user_id,
    nullif(p_payload ->> 'manager_memo', ''),
    nullif(p_payload ->> 'source_key', ''),
    coalesce(p_payload -> 'raw_payload', '{}'::jsonb)
  )
  returning id into created_request_id;

  perform public.gw_approve_paid_leave_request(
    created_request_id,
    p_actor_user_id
  );

  return jsonb_build_object(
    'request_id', created_request_id,
    'status', 'approved'
  );
end;
$$;

create or replace function public.gw_sync_shift_paid_leave_batch(
  p_period_id uuid,
  p_rows jsonb,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_period public.gw_shift_periods%rowtype;
  item jsonb;
  target_request public.gw_paid_leave_requests%rowtype;
  assignment_id uuid;
  synced_count integer := 0;
begin
  select *
  into target_period
  from public.gw_shift_periods
  where id = p_period_id
  for update;

  if not found then
    raise exception 'シフト期間が見つかりません';
  end if;

  if target_period.is_test_mode then
    return jsonb_build_object('synced', 0, 'skipped_test_mode', true);
  end if;

  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception '有給同期データの形式が不正です';
  end if;

  for item in
    select value
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    assignment_id := nullif(item ->> 'shift_assignment_id', '')::uuid;

    if item ->> 'leave_unit' = 'full_day' and assignment_id is null then
      insert into public.gw_shift_assignments (
        period_id,
        user_id,
        employee_id,
        work_date,
        pattern_id,
        shift_label,
        start_time,
        end_time,
        break_minutes,
        work_minutes,
        assignment_type,
        note,
        source,
        created_by,
        updated_by,
        updated_at
      )
      values (
        p_period_id,
        (item ->> 'user_id')::uuid,
        (item ->> 'employee_id')::uuid,
        (item ->> 'work_date')::date,
        null,
        '有給（全休）',
        nullif(item ->> 'start_time', '')::time,
        nullif(item ->> 'end_time', '')::time,
        coalesce(nullif(item ->> 'break_minutes', '')::integer, 0),
        (item ->> 'scheduled_minutes_snapshot')::integer,
        'staff',
        '__paid_leave_full__',
        'manual',
        p_actor_user_id,
        p_actor_user_id,
        now()
      )
      on conflict (period_id, user_id, work_date)
      do update
      set employee_id = excluded.employee_id,
          shift_label = excluded.shift_label,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          break_minutes = excluded.break_minutes,
          work_minutes = excluded.work_minutes,
          note = excluded.note,
          updated_by = excluded.updated_by,
          updated_at = now()
      returning id into assignment_id;
    end if;

    select *
    into target_request
    from public.gw_paid_leave_requests
    where source_key = item ->> 'source_key'
    for update;

    if found then
      if target_request.request_status = 'consumed' then
        raise exception '消化済みの有給申請はシフトから更新できません';
      end if;

      update public.gw_paid_leave_requests
      set employee_id = (item ->> 'employee_id')::uuid,
          user_id = (item ->> 'user_id')::uuid,
          leave_date = (item ->> 'work_date')::date,
          leave_unit = item ->> 'leave_unit',
          request_source = 'shift_preference',
          request_status = 'submitted',
          shift_period_id = p_period_id,
          shift_assignment_id = assignment_id,
          scheduled_minutes_snapshot = (item ->> 'scheduled_minutes_snapshot')::integer,
          wage_method = 'ordinary_wage',
          hourly_rate_snapshot = nullif(item ->> 'hourly_rate_snapshot', '')::numeric,
          payable_minutes_snapshot = (item ->> 'payable_minutes_snapshot')::integer,
          paid_wage_amount = (item ->> 'paid_wage_amount')::numeric,
          requested_by = (item ->> 'user_id')::uuid,
          employee_memo = nullif(item ->> 'employee_memo', ''),
          rejected_by = null,
          rejected_at = null,
          cancelled_by = null,
          cancelled_at = null,
          raw_payload = coalesce(item -> 'raw_payload', '{}'::jsonb),
          updated_at = now()
      where id = target_request.id;
    else
      insert into public.gw_paid_leave_requests (
        employee_id, user_id, leave_date, leave_unit, request_source,
        request_status, shift_period_id, shift_assignment_id,
        scheduled_minutes_snapshot, wage_method, hourly_rate_snapshot,
        payable_minutes_snapshot, paid_wage_amount, requested_by,
        employee_memo, source_key, raw_payload
      )
      values (
        (item ->> 'employee_id')::uuid,
        (item ->> 'user_id')::uuid,
        (item ->> 'work_date')::date,
        item ->> 'leave_unit',
        'shift_preference',
        'submitted',
        p_period_id,
        assignment_id,
        (item ->> 'scheduled_minutes_snapshot')::integer,
        'ordinary_wage',
        nullif(item ->> 'hourly_rate_snapshot', '')::numeric,
        (item ->> 'payable_minutes_snapshot')::integer,
        (item ->> 'paid_wage_amount')::numeric,
        (item ->> 'user_id')::uuid,
        nullif(item ->> 'employee_memo', ''),
        item ->> 'source_key',
        coalesce(item -> 'raw_payload', '{}'::jsonb)
      )
      returning * into target_request;
    end if;

    perform public.gw_approve_paid_leave_request(
      target_request.id,
      p_actor_user_id
    );

    update public.gw_shift_requests
    set status = 'accepted',
        updated_at = now()
    where id = (item ->> 'shift_request_id')::uuid
      and period_id = p_period_id;

    synced_count := synced_count + 1;
  end loop;

  update public.gw_shift_periods
  set status = 'confirmed',
      confirmed_by = p_actor_user_id,
      confirmed_at = now(),
      updated_at = now()
  where id = p_period_id;

  return jsonb_build_object('synced', synced_count, 'skipped_test_mode', false);
end;
$$;

create or replace function public.gw_import_paid_leave_usage(
  p_employee_id uuid,
  p_user_id uuid,
  p_used_days numeric,
  p_effective_date date,
  p_note text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining_days numeric(5,2);
  request_days numeric(3,1);
  request_unit text;
  created_request_id uuid;
begin
  if p_used_days <= 0 or p_used_days * 2 <> trunc(p_used_days * 2) then
    raise exception '使用済み日数は0.5日単位で指定してください';
  end if;

  remaining_days := p_used_days;
  while remaining_days > 0 loop
    request_days := least(remaining_days, 1);
    request_unit := case when request_days = 1 then 'full_day' else 'half_day' end;

    insert into public.gw_paid_leave_requests (
      employee_id, user_id, leave_date, leave_unit, request_source,
      request_status, requested_by, manager_memo, source_key, raw_payload
    )
    values (
      p_employee_id,
      p_user_id,
      p_effective_date,
      request_unit,
      'import',
      'submitted',
      p_actor_user_id,
      nullif(btrim(coalesce(p_note, '')), ''),
      'opening-usage:' || p_employee_id::text || ':' || gen_random_uuid()::text,
      jsonb_build_object('opening_balance_adjustment', true)
    )
    returning id into created_request_id;

    perform public.gw_approve_paid_leave_request(
      created_request_id,
      p_actor_user_id
    );

    remaining_days := remaining_days - request_days;
  end loop;

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'used_days', p_used_days,
    'status', 'approved'
  );
end;
$$;

revoke all on function public.gw_approve_paid_leave_request(uuid, uuid) from public;
revoke all on function public.gw_confirm_workday_resolution(uuid, uuid, text) from public;
revoke all on function public.gw_reject_paid_leave_request(uuid, uuid, text) from public;
revoke all on function public.gw_reopen_workday_resolution(uuid, uuid) from public;
revoke all on function public.gw_create_and_approve_paid_leave_request(jsonb, uuid) from public;
revoke all on function public.gw_sync_shift_paid_leave_batch(uuid, jsonb, uuid) from public;
revoke all on function public.gw_import_paid_leave_usage(uuid, uuid, numeric, date, text, uuid) from public;

alter table public.gw_paid_leave_profiles enable row level security;
alter table public.gw_paid_leave_grant_lots enable row level security;
alter table public.gw_paid_leave_requests enable row level security;
alter table public.gw_workday_resolutions enable row level security;
alter table public.gw_paid_leave_consumption_allocations enable row level security;
alter table public.gw_paid_leave_average_snapshots enable row level security;
alter table public.gw_paid_leave_audit_logs enable row level security;
alter table public.gw_proxy_view_audit_logs enable row level security;

grant all on public.gw_paid_leave_profiles to service_role;
grant all on public.gw_paid_leave_grant_lots to service_role;
grant all on public.gw_paid_leave_requests to service_role;
grant all on public.gw_workday_resolutions to service_role;
grant all on public.gw_paid_leave_consumption_allocations to service_role;
grant all on public.gw_paid_leave_average_snapshots to service_role;
grant all on public.gw_paid_leave_audit_logs to service_role;
grant all on public.gw_proxy_view_audit_logs to service_role;
grant select on public.gw_paid_leave_grant_balances to service_role;
grant execute on function public.gw_approve_paid_leave_request(uuid, uuid) to service_role;
grant execute on function public.gw_confirm_workday_resolution(uuid, uuid, text) to service_role;
grant execute on function public.gw_reject_paid_leave_request(uuid, uuid, text) to service_role;
grant execute on function public.gw_reopen_workday_resolution(uuid, uuid) to service_role;
grant execute on function public.gw_create_and_approve_paid_leave_request(jsonb, uuid) to service_role;
grant execute on function public.gw_sync_shift_paid_leave_batch(uuid, jsonb, uuid) to service_role;
grant execute on function public.gw_import_paid_leave_usage(uuid, uuid, numeric, date, text, uuid) to service_role;

insert into public.gw_paid_leave_profiles (employee_id, user_id)
select employees.id, employees.user_id
from public.gw_payroll_employees employees
where employees.payroll_status = 'active'
on conflict (employee_id) do update
set user_id = excluded.user_id,
    updated_at = now();

do $$
declare
  request_type_constraint text;
begin
  for request_type_constraint in
    select constraints.conname
    from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'gw_shift_requests'
      and constraints.contype = 'c'
      and pg_get_constraintdef(constraints.oid) ilike '%request_type%'
  loop
    execute format(
      'alter table public.gw_shift_requests drop constraint %I',
      request_type_constraint
    );
  end loop;
end
$$;

alter table public.gw_shift_requests
  add constraint gw_shift_requests_request_type_check
  check (
    request_type in (
      'day_off',
      'unavailable',
      'available',
      'time_preference',
      'note',
      'paid_leave_full',
      'paid_leave_half'
    )
  );

do $$
declare
  user_fk_constraint text;
begin
  for user_fk_constraint in
    select constraints.conname
    from pg_constraint constraints
    join pg_class tables on tables.oid = constraints.conrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    join unnest(constraints.conkey) as key(attnum) on true
    join pg_attribute columns
      on columns.attrelid = tables.oid
      and columns.attnum = key.attnum
    where schemas.nspname = 'public'
      and tables.relname = 'gw_shift_assignments'
      and constraints.contype = 'f'
      and columns.attname = 'user_id'
  loop
    execute format(
      'alter table public.gw_shift_assignments drop constraint %I',
      user_fk_constraint
    );
  end loop;
end
$$;

alter table public.gw_shift_assignments
  add constraint gw_shift_assignments_user_id_fkey
  foreign key (user_id) references public.gw_users(id) on delete set null;

comment on table public.gw_paid_leave_profiles is
  'Employee paid-leave policy and next statutory grant projection. The default statutory threshold grants at 80% or higher.';
comment on table public.gw_paid_leave_grant_lots is
  'Paid-leave grant lots. expires_on is exclusive and fixed at two years after grant_date.';
comment on table public.gw_paid_leave_requests is
  'Full-day or half-day paid-leave requests. half_day is the UI-neutral half-day value; AM/PM values remain available for future use. Ordinary wage snapshots use confirmed scheduled minutes and the effective hourly rate.';
comment on table public.gw_workday_resolutions is
  'Administrator-confirmed resolution for a confirmed workday without a valid punch. A missing punch alone is not an absence.';
comment on table public.gw_paid_leave_average_snapshots is
  'Three-month hours and wage snapshots. reference_display rows are informational and are not the ordinary-wage calculation source.';
comment on view public.gw_paid_leave_grant_balances is
  'Current grant-lot balance. expires_on is treated as an exclusive boundary.';

commit;
