alter table public.gw_workday_resolutions
  drop constraint if exists gw_workday_resolutions_resolution_type_check;

alter table public.gw_workday_resolutions
  add constraint gw_workday_resolutions_resolution_type_check
  check (
    resolution_type in (
      'pending',
      'punch_missing',
      'punch_correction',
      'paid_leave_full',
      'paid_leave_half',
      'bereavement_leave',
      'absence',
      'work_schedule_changed',
      'employer_shutdown'
    )
  );

comment on column public.gw_workday_resolutions.resolution_type is
  'Missing-punch resolution. bereavement_leave is available only to regular employees and does not consume paid leave or count as absence.';
