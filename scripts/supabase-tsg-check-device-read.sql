select
  to_regclass('public.gw_device_read_status') as device_read_table,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'gw_push_subscriptions'
      and column_name = 'device_id'
  ) as push_subscription_device_id;
