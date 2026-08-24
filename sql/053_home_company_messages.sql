create table if not exists public.gw_home_company_messages (
  id uuid primary key default gen_random_uuid(),
  author_user_id uuid not null references public.gw_users(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 5000),
  attachment jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gw_home_company_message_recipients (
  message_id uuid not null references public.gw_home_company_messages(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists idx_gw_home_company_message_recipients_visible
  on public.gw_home_company_message_recipients (user_id, created_at desc)
  where dismissed_at is null;

alter table public.gw_home_company_messages enable row level security;
alter table public.gw_home_company_message_recipients enable row level security;

insert into public.gw_feature_roles (feature_key, role_key, user_id, note)
select
  'home_company_message',
  'author',
  id,
  '全社員ホームメッセージ送信者'
from public.gw_users
where status = 'approved'
  and regexp_replace(coalesce(real_name, display_name), '\s|　', '', 'g') = '佐藤正彦'
on conflict (feature_key, role_key, user_id) do nothing;
