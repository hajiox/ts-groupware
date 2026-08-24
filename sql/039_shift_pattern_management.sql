alter table public.gw_shift_patterns
  add column if not exists pattern_role text not null default 'standard';

update public.gw_shift_patterns
set pattern_role = case
  when department = 'フロア' and label = 'フロア勤務' then 'floor_work'
  when label = '基本勤務' or label like '基本勤務%' then 'basic_work'
  else 'standard'
end
where pattern_role = 'standard';

alter table public.gw_shift_patterns
  drop constraint if exists gw_shift_patterns_pattern_role_check;

alter table public.gw_shift_patterns
  add constraint gw_shift_patterns_pattern_role_check
  check (pattern_role in ('standard', 'basic_work', 'floor_work'));

create index if not exists idx_gw_shift_patterns_department_active_order
  on public.gw_shift_patterns (department, is_active, sort_order, label);
