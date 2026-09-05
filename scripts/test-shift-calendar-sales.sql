begin;
do $$
declare
  v_calendar text := 'test_shift_calendar_' || gen_random_uuid();
  v_token uuid := gen_random_uuid();
  v_event jsonb; v_removed integer; v_period uuid; v_row gw_shift_requirements;
begin
  if not gw_claim_calendar_sync(v_calendar, v_token) then raise exception 'Lease claim failed'; end if;
  if gw_claim_calendar_sync(v_calendar, gen_random_uuid()) then raise exception 'Duplicate lease accepted'; end if;
  select jsonb_build_object('title','Calendar sync transaction test','starts_at','2099-01-01T00:00:00Z',
    'ends_at','2099-01-02T00:00:00Z','all_day',true,'color','#0b8043','source','google_calendar',
    'external_id',v_calendar || ':test','created_by',id,'updated_at',now())
    into v_event from gw_users limit 1;
  perform gw_replace_google_calendar_range(v_calendar,v_token,'2099-01-01','2099-01-03',jsonb_build_array(v_event));
  if (select count(*) from gw_calendar_events where external_id=v_calendar || ':test') <> 1 then raise exception 'Snapshot insert failed'; end if;
  perform gw_replace_google_calendar_range(v_calendar,v_token,'2099-01-01','2099-01-03',jsonb_build_array(v_event));
  if (select count(*) from gw_calendar_events where external_id=v_calendar || ':test') <> 1 then raise exception 'Snapshot duplicate'; end if;
  v_removed := gw_replace_google_calendar_range(v_calendar,v_token,'2099-01-01','2099-01-03','[]'::jsonb);
  if v_removed <> 1 then raise exception 'Snapshot cancellation failed'; end if;

  select id into v_period from gw_shift_periods where department='フロア' and status='confirmed' limit 1;
  if gw_apply_shift_calendar_sales(v_period, '[]'::jsonb) <> 0 then raise exception 'Confirmed period modified'; end if;
  select r.* into v_row from gw_shift_requirements r join gw_shift_periods p on p.id=r.period_id
    where p.department='フロア' and p.status='editing' limit 1;
  if v_row.id is not null then
    if gw_apply_shift_calendar_sales(v_row.period_id, jsonb_build_array(jsonb_build_object(
      'work_date',v_row.work_date,'previous_tags','["outdated"]'::jsonb,
      'previous_times',v_row.ec_sale_times,'previous_state',v_row.calendar_sale_state,
      'ec_sale_tags','[]'::jsonb,'ec_sale_times','{}'::jsonb,'calendar_sale_state','{}'::jsonb))) <> 0
    then raise exception 'Concurrent manual edit overwritten'; end if;
  end if;
end $$;
rollback;
