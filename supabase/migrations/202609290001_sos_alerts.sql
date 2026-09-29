create table public.gw_sos_alerts (
 id uuid primary key default gen_random_uuid(),
 device_id uuid not null references public.gw_attendance_devices(id),
 device_name text not null,
 created_at timestamptz not null default now(),
 status text not null default 'pending' check (status in ('pending','acknowledged','resolved')),
 acknowledged_by uuid references public.gw_users(id),
 acknowledged_name text,
 acknowledged_at timestamptz,
 resolved_at timestamptz,
 next_notification_at timestamptz default now(),
 dispatch_count integer not null default 0
);
create unique index gw_sos_one_active_device on public.gw_sos_alerts(device_id) where status <> 'resolved';
create index gw_sos_due on public.gw_sos_alerts(next_notification_at) where status='pending';
create table public.gw_sos_deliveries (
 id uuid primary key default gen_random_uuid(),
 alert_id uuid not null references public.gw_sos_alerts(id),
 user_id uuid not null references public.gw_users(id),
 attempt integer not null,
 created_at timestamptz not null default now(),
 accepted integer not null default 0,
 failed integer not null default 0,
 outcome text not null default 'sending',
 receipt_token uuid not null default gen_random_uuid() unique,
 received_at timestamptz,
 displayed_at timestamptz,
 clicked_at timestamptz,
 display_failed_at timestamptz,
 unique(alert_id,user_id,attempt)
);
alter table public.gw_sos_alerts enable row level security;
alter table public.gw_sos_deliveries enable row level security;
revoke all on public.gw_sos_alerts,public.gw_sos_deliveries from public,anon,authenticated;
grant all on public.gw_sos_alerts,public.gw_sos_deliveries to service_role;

-- The device row lock serializes double taps and concurrent requests.
create function public.gw_create_sos(p_device_id uuid) returns public.gw_sos_alerts
language plpgsql security definer set search_path=public as $$
declare d public.gw_attendance_devices; a public.gw_sos_alerts;
begin
 select * into d from public.gw_attendance_devices where id=p_device_id and is_active for update;
 if not found then raise exception 'Inactive device'; end if;
 select * into a from public.gw_sos_alerts where device_id=d.id and status<>'resolved';
 if found then return a; end if;
 insert into public.gw_sos_alerts(device_id,device_name) values(d.id,d.name) returning * into a;
 return a;
end $$;

-- Claim due alerts atomically, shared by the cron and foreground heartbeat.
create function public.gw_claim_due_sos(p_alert_id uuid default null) returns setof public.gw_sos_alerts
language sql security definer set search_path=public as $$
 update public.gw_sos_alerts set next_notification_at=now()+interval '2 minutes',dispatch_count=dispatch_count+1
 where id in (select id from public.gw_sos_alerts
   where status='pending' and next_notification_at<=now() and (p_alert_id is null or id=p_alert_id)
   order by next_notification_at limit 10 for update skip locked)
 returning *;
$$;
revoke all on function public.gw_create_sos(uuid),public.gw_claim_due_sos(uuid) from public,anon,authenticated;
grant execute on function public.gw_create_sos(uuid),public.gw_claim_due_sos(uuid) to service_role;
