-- Replace the initial statutory estimates with the balances confirmed in the
-- former leave boards, then register the one-day monthly transition grants.

do $$
declare
  target record;
  current_lot record;
  target_count integer := 0;
  normalized_name text;
begin
  for target in
    select
      employees.id as employee_id,
      employees.user_id,
      employees.real_name,
      case regexp_replace(
        coalesce(employees.real_name, employees.display_name, ''),
        '[[:space:]　]',
        '',
        'g'
      )
        when '藤田香織' then 16.0::numeric
        when '渡部瞳' then 36.5::numeric
        when '武藤志保' then 1.0::numeric
        when '石井瑞季' then 16.0::numeric
      end as target_balance
    from public.gw_payroll_employees employees
    where employees.payroll_status = 'active'
      and regexp_replace(
        coalesce(employees.real_name, employees.display_name, ''),
        '[[:space:]　]',
        '',
        'g'
      ) in ('藤田香織', '渡部瞳', '武藤志保', '石井瑞季')
  loop
    target_count := target_count + 1;
    normalized_name := regexp_replace(coalesce(target.real_name, ''), '[[:space:]　]', '', 'g');

    select
      lots.id,
      lots.granted_days,
      lots.grant_source,
      lots.initial_assumption,
      lots.source_key,
      lots.notes,
      coalesce(sum(allocations.allocated_days) filter (where allocations.voided_at is null), 0)::numeric(5,2)
        as allocated_days
    into current_lot
    from public.gw_paid_leave_grant_lots lots
    left join public.gw_paid_leave_consumption_allocations allocations
      on allocations.grant_lot_id = lots.id
    where lots.employee_id = target.employee_id
      and lots.grant_status = 'granted'
      and lots.grant_date <= date '2026-07-26'
    group by lots.id
    order by lots.grant_date desc, lots.created_at desc
    limit 1;

    if current_lot.id is null then
      raise exception '有給開始残高の対象ロットが見つかりません: %', target.real_name;
    end if;

    update public.gw_paid_leave_grant_lots
    set
      granted_days = target.target_balance + current_lot.allocated_days,
      grant_source = 'carryover_import',
      initial_assumption = false,
      source_key = 'paid-leave-opening-balance-2026-07-26:' || target.employee_id::text,
      notes = format(
        '旧有給管理からの確定残高移行（2026-07-26時点 %s日）',
        target.target_balance
      ),
      updated_at = now()
    where id = current_lot.id;

    insert into public.gw_paid_leave_audit_logs (
      employee_id,
      user_id,
      entity_type,
      entity_id,
      action,
      actor_type,
      source,
      before_payload,
      after_payload
    )
    values (
      target.employee_id,
      target.user_id,
      'grant_lot',
      current_lot.id,
      'import',
      'system',
      'paid_leave_transition_2026',
      jsonb_build_object(
        'granted_days', current_lot.granted_days,
        'allocated_days', current_lot.allocated_days,
        'remaining_days', greatest(current_lot.granted_days - current_lot.allocated_days, 0),
        'grant_source', current_lot.grant_source,
        'initial_assumption', current_lot.initial_assumption
      ),
      jsonb_build_object(
        'target_remaining_days', target.target_balance,
        'granted_days', target.target_balance + current_lot.allocated_days,
        'allocated_days', current_lot.allocated_days,
        'grant_source', 'carryover_import',
        'initial_assumption', false,
        'staff', normalized_name
      )
    );
  end loop;

  if target_count <> 4 then
    raise exception '有給移行対象は4名の想定ですが、%名見つかりました', target_count;
  end if;
end
$$;

with target_employees as (
  select
    employees.id as employee_id,
    employees.user_id,
    regexp_replace(
      coalesce(employees.real_name, employees.display_name, ''),
      '[[:space:]　]',
      '',
      'g'
    ) as normalized_name
  from public.gw_payroll_employees employees
  where employees.payroll_status = 'active'
),
transition_dates (normalized_name, grant_date) as (
  values
    ('藤田香織', date '2026-08-01'),
    ('藤田香織', date '2026-09-01'),
    ('藤田香織', date '2026-10-01'),
    ('渡部瞳', date '2026-08-01'),
    ('渡部瞳', date '2026-09-01'),
    ('武藤志保', date '2026-08-01'),
    ('武藤志保', date '2026-09-01'),
    ('武藤志保', date '2026-10-01'),
    ('武藤志保', date '2026-11-01'),
    ('武藤志保', date '2026-12-01'),
    ('武藤志保', date '2027-01-01'),
    ('武藤志保', date '2027-02-01'),
    ('武藤志保', date '2027-03-01'),
    ('石井瑞季', date '2026-08-01'),
    ('石井瑞季', date '2026-09-01'),
    ('石井瑞季', date '2026-10-01'),
    ('石井瑞季', date '2026-11-01'),
    ('石井瑞季', date '2026-12-01'),
    ('石井瑞季', date '2027-01-01'),
    ('石井瑞季', date '2027-02-01'),
    ('石井瑞季', date '2027-03-01'),
    ('石井瑞季', date '2027-04-01')
),
inserted as (
  insert into public.gw_paid_leave_grant_lots (
    employee_id,
    user_id,
    grant_date,
    expires_on,
    granted_days,
    grant_source,
    grant_status,
    initial_assumption,
    source_key,
    notes
  )
  select
    employees.employee_id,
    employees.user_id,
    transition_dates.grant_date,
    (transition_dates.grant_date + interval '2 years')::date,
    1.0,
    'manual_adjustment',
    'granted',
    false,
    'paid-leave-transition-monthly-2026:'
      || employees.employee_id::text
      || ':'
      || transition_dates.grant_date::text,
    '8月更新から入社日基準への移行調整休暇（月1日）'
  from transition_dates
  join target_employees employees
    on employees.normalized_name = transition_dates.normalized_name
  on conflict (source_key) where source_key is not null do nothing
  returning id, employee_id, user_id, grant_date, expires_on, granted_days, source_key
)
insert into public.gw_paid_leave_audit_logs (
  employee_id,
  user_id,
  entity_type,
  entity_id,
  action,
  actor_type,
  source,
  after_payload
)
select
  inserted.employee_id,
  inserted.user_id,
  'grant_lot',
  inserted.id,
  'create',
  'system',
  'paid_leave_transition_2026',
  jsonb_build_object(
    'grant_date', inserted.grant_date,
    'expires_on', inserted.expires_on,
    'granted_days', inserted.granted_days,
    'source_key', inserted.source_key
  )
from inserted;

with profile_targets (normalized_name, next_grant_date, projected_grant_days, transition_days) as (
  values
    ('藤田香織', date '2026-10-02', 20.0::numeric, 3),
    ('渡部瞳', date '2026-09-12', 20.0::numeric, 2),
    ('武藤志保', date '2027-04-01', 14.0::numeric, 8),
    ('石井瑞季', date '2027-04-24', 16.0::numeric, 9)
)
update public.gw_paid_leave_profiles profiles
set
  next_grant_date = targets.next_grant_date,
  projected_grant_days = targets.projected_grant_days,
  notes = concat_ws(
    E'\n',
    nullif(profiles.notes, ''),
    format(
      '2026年移行調整: 8月から個人基準日まで月1日、合計%s日を別途付与',
      targets.transition_days
    )
  ),
  updated_at = now()
from public.gw_payroll_employees employees
join profile_targets targets
  on targets.normalized_name = regexp_replace(
    coalesce(employees.real_name, employees.display_name, ''),
    '[[:space:]　]',
    '',
    'g'
  )
where profiles.employee_id = employees.id;
