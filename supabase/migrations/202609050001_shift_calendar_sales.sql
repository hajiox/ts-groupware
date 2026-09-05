alter table public.gw_shift_requirements
  add column if not exists calendar_sale_state jsonb not null default '{}'::jsonb;

-- Compare the fields read by the synchronizer so an in-flight manual save wins.
create or replace function public.gw_apply_shift_calendar_sales(p_period_id uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; changed integer := 0; affected integer;
begin
  perform 1 from gw_shift_periods where id = p_period_id
    and department = 'フロア' and status not in ('confirmed', 'exported', 'archived') for update;
  if not found then return 0; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    update gw_shift_requirements set
      ec_sale_tags = array(select jsonb_array_elements_text(r->'ec_sale_tags')),
      ec_sale_times = r->'ec_sale_times',
      calendar_sale_state = r->'calendar_sale_state', updated_at = now()
    where period_id = p_period_id and work_date = (r->>'work_date')::date
      and to_jsonb(ec_sale_tags) = r->'previous_tags'
      and ec_sale_times = r->'previous_times'
      and calendar_sale_state = r->'previous_state';
    get diagnostics affected = row_count;
    changed := changed + affected;
  end loop;
  return changed;
end $$;
revoke all on function public.gw_apply_shift_calendar_sales(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.gw_apply_shift_calendar_sales(uuid,jsonb) to service_role;

create table if not exists public.gw_calendar_sync_leases (
  calendar_id text primary key, token uuid not null, expires_at timestamptz not null
);
alter table public.gw_calendar_sync_leases enable row level security;
grant all on public.gw_calendar_sync_leases to service_role;

create or replace function public.gw_claim_calendar_sync(p_calendar_id text, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into gw_calendar_sync_leases values (p_calendar_id, p_token, now() + interval '2 minutes')
  on conflict (calendar_id) do update set token = excluded.token, expires_at = excluded.expires_at
    where gw_calendar_sync_leases.expires_at < now();
  return found;
end $$;
revoke all on function public.gw_claim_calendar_sync(text,uuid) from public, anon, authenticated;
grant execute on function public.gw_claim_calendar_sync(text,uuid) to service_role;

-- A complete Google snapshot is committed atomically; a failed page never removes cached events.
create or replace function public.gw_replace_google_calendar_range(
  p_calendar_id text, p_token uuid, p_start timestamptz, p_end timestamptz, p_events jsonb
) returns integer language plpgsql security definer set search_path = public as $$
declare removed integer;
begin
  perform 1 from gw_calendar_sync_leases where calendar_id = p_calendar_id
    and token = p_token and expires_at > now() for update;
  if not found then raise exception 'Calendar sync lease expired'; end if;
  if p_end <= p_start or jsonb_typeof(p_events) <> 'array' then raise exception 'Invalid calendar snapshot'; end if;
  if exists (select 1 from jsonb_array_elements(p_events) e where
    e->>'source' is distinct from 'google_calendar' or
    left(e->>'external_id', length(p_calendar_id) + 1) is distinct from p_calendar_id || ':')
  then raise exception 'Calendar source mismatch'; end if;

  insert into gw_calendar_events(title, description, location, starts_at, ends_at, all_day,
    color, source, external_id, source_updated_at, created_by, updated_at)
  select e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day,
    e.color, e.source, e.external_id, e.source_updated_at, e.created_by, e.updated_at
  from jsonb_populate_recordset(null::gw_calendar_events, p_events) e
  on conflict (source, external_id) do update set title = excluded.title,
    description = excluded.description, location = excluded.location, starts_at = excluded.starts_at,
    ends_at = excluded.ends_at, all_day = excluded.all_day, color = excluded.color,
    source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at;

  delete from gw_calendar_events e where e.source = 'google_calendar'
    and left(e.external_id, length(p_calendar_id) + 1) = p_calendar_id || ':'
    and e.starts_at < p_end and e.ends_at > p_start
    and not exists(select 1 from jsonb_array_elements(p_events) v where v->>'external_id' = e.external_id);
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function public.gw_replace_google_calendar_range(text,uuid,timestamptz,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.gw_replace_google_calendar_range(text,uuid,timestamptz,timestamptz,jsonb) to service_role;
notify pgrst, 'reload schema';
