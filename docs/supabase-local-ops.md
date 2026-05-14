# Supabase local operations for TSG

TSG uses the shared `oem-btob` Supabase project:

- Project ref: `zfhswguzqyagmhhlpksq`
- Safe TSG namespace: `gw_` tables only
- Related systems share this database, so avoid non-`gw_` schema changes from this repo.

## One-time setup

Create a Supabase access token:

https://supabase.com/dashboard/account/tokens

Then run:

```powershell
cd C:\作業用\ts-groupware
powershell -ExecutionPolicy Bypass -File scripts\supabase-tsg-login.ps1
```

Paste the access token when prompted.

If the CLI asks for the database password during link, get it from Supabase project database settings and rerun:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase-tsg-login.ps1 -DbPassword "postgres-password"
```

Do not commit access tokens, database passwords, `.env*.local`, or files under `supabase/.temp`.

## Run a SQL file

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase-tsg-run-sql.ps1 -File sql\008_device_read_status.sql
```

## Verify the device-read migration

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase-tsg-check.ps1
```

Expected result:

- `device_read_table` is `gw_device_read_status`
- `push_subscription_device_id` is `true`

## Migration convention

Keep Supabase CLI migrations in:

```text
supabase/migrations/
```

The current migration mirror for `sql/008_device_read_status.sql` is:

```text
supabase/migrations/202605140001_device_read_status.sql
```
