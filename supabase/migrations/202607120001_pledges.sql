create table if not exists public.gw_pledge_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  check_items jsonb not null default '[]'::jsonb,
  agreement_label text not null,
  company_name text not null,
  is_active boolean not null default true,
  created_by uuid references public.gw_users(id) on delete set null,
  updated_by uuid references public.gw_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gw_pledge_deliveries (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.gw_pledge_templates(id) on delete set null,
  title_snapshot text not null,
  body_snapshot text not null,
  check_items_snapshot jsonb not null,
  agreement_label_snapshot text not null,
  company_name_snapshot text not null,
  target_type text not null check (target_type in ('all', 'department', 'individual', 'test')),
  target_label text,
  is_test boolean not null default false,
  sent_by uuid references public.gw_users(id) on delete set null,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.gw_pledge_assignments (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.gw_pledge_deliveries(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'submitted')),
  accepted_item_ids text[] not null default '{}'::text[],
  signer_name text,
  pledged_at timestamptz,
  signed_attachment jsonb,
  dm_group_id uuid references public.gw_groups(id) on delete set null,
  dm_post_id uuid references public.gw_posts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (delivery_id, user_id)
);

create index if not exists idx_gw_pledge_assignments_user_status
  on public.gw_pledge_assignments(user_id, status, created_at desc);
create index if not exists idx_gw_pledge_assignments_delivery
  on public.gw_pledge_assignments(delivery_id, status);

alter table public.gw_pledge_templates enable row level security;
alter table public.gw_pledge_deliveries enable row level security;
alter table public.gw_pledge_assignments enable row level security;

insert into public.gw_pledge_templates (
  id,
  title,
  body,
  check_items,
  agreement_label,
  company_name
)
values (
  '00000000-0000-4000-8000-000000000001',
  '会社機密情報に関する誓約',
  $$当社のレシピ、配合、製造・調理方法などの非公開情報は、会社の重要な機密情報です。

【重要】

会社の営業秘密を不正に持ち出し、使用し、または第三者に漏らした場合、不正競争防止法違反（営業秘密侵害罪）として、10年以下の拘禁刑もしくは2,000万円以下の罰金、またはその両方が科される場合があります。

また、会社は必要に応じて、懲戒処分、刑事告訴、損害賠償請求を行います。$$,
  jsonb_build_array(
    jsonb_build_object('id', 'confidentiality', 'text', '会社の許可なく、社外の人に話す、見せる、送るなどの行為をしません。'),
    jsonb_build_object('id', 'no_copy', 'text', '写真撮影、コピー、私物端末への保存、LINE・メール・SNS等への送信や持ち出しをしません。'),
    jsonb_build_object('id', 'no_competitive_use', 'text', '自分または他人の副業、転職、独立、競合事業などに使用・提供しません。'),
    jsonb_build_object('id', 'after_employment', 'text', '在職中・退職後を問わず、会社の機密情報を漏らしたり、不正に使用したりしないことを誓約します。')
  ),
  '上記内容を確認し、誓約する',
  '株式会社テクニカルスタッフ'
)
on conflict (id) do nothing;

comment on table public.gw_pledge_templates is 'Editable pledge templates.';
comment on table public.gw_pledge_deliveries is 'Immutable pledge snapshots distributed to users.';
comment on table public.gw_pledge_assignments is 'Per-user pledge acceptance and signed PDF record.';
