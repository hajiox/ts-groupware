alter table public.gw_home_company_messages
  add column if not exists title text;

update public.gw_home_company_messages
set title = left(
  coalesce(
    nullif(btrim(split_part(body, E'\n', 1)), ''),
    '全社員メッセージ'
  ),
  80
)
where title is null or btrim(title) = '';

alter table public.gw_home_company_messages
  alter column title set default '全社員メッセージ',
  alter column title set not null;

create index if not exists idx_gw_home_company_messages_created_at
  on public.gw_home_company_messages (created_at desc);
