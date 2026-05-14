-- Supabase Data API explicit grants
-- Date: 2026-05-14
--
-- This migration is intentionally additive only.
-- It does not change RLS, revoke permissions, or modify data.

grant usage on schema public to anon, authenticated, service_role;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

do $$
declare
  p record;
  target_role text;
  target_oid oid;
  grant_privs text;
begin
  for p in
    select
      n.nspname as schema_name,
      c.relname as table_name,
      pol.polcmd,
      pol.polroles
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    foreach target_role in array array['anon', 'authenticated'] loop
      select oid into target_oid from pg_roles where rolname = target_role;
      if 0::oid = any(p.polroles) or target_oid = any(p.polroles) then
        grant_privs := '';
        if p.polcmd in ('*', 'r') then grant_privs := grant_privs || 'select, '; end if;
        if p.polcmd in ('*', 'a') then grant_privs := grant_privs || 'insert, '; end if;
        if p.polcmd in ('*', 'w') then grant_privs := grant_privs || 'update, '; end if;
        if p.polcmd in ('*', 'd') then grant_privs := grant_privs || 'delete, '; end if;

        if grant_privs <> '' then
          grant_privs := left(grant_privs, length(grant_privs) - 2);
          execute format('grant %s on table %I.%I to %I', grant_privs, p.schema_name, p.table_name, target_role);
        end if;
      end if;
    end loop;
  end loop;
end $$;

