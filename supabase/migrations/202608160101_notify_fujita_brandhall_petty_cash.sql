begin;

do $dm$
declare
  tsg_id uuid;
  tsg_name text;
  fujita_id uuid;
  fujita_name text;
  direct_key text;
  direct_group_id uuid;
  message_id uuid;
  message_created_at timestamptz;
  target_count integer;
  message_body constant text := $message$藤田さん

会津ブランド館の小口現金管理を、単独で運用できるように改修しました。

・入金日、受取元・摘要、金額を登録できます
・レシートのPDF・画像を取り込むと、OCRで読み取り、小口の出金として残高から自動で差し引きます
・クレジット払いのレシートは小口現金から差し引きません
・月ごとの明細一覧、Excel出力、A4印刷ができます
・会計事務所提出用として、レシートを日付別にA4白台紙へ原寸配置して印刷できます。同じ日のレシートが多い場合は複数ページになります

製造・道の駅・現金出納簿のデータは将来の連動用に残し、現在の会津ブランド館の残高計算とは分離しています。

2026年8月の実データで、月初100,658円、レシート3件・出金12,608円、月末88,050円になることを、画面・Excel・印刷で確認済みです。

利用画面：
http://192.168.110.200:3004/petty-cash

以上、対応完了です。$message$;
begin
  select count(*)
  into target_count
  from public.gw_users users
  where users.status = 'approved'
    and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = 'TSG君';

  if target_count <> 1 then
    raise exception 'TSG君を一意特定できません（%件）', target_count;
  end if;

  select users.id, coalesce(users.real_name, users.display_name)
  into tsg_id, tsg_name
  from public.gw_users users
  where users.status = 'approved'
    and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = 'TSG君';

  select count(*)
  into target_count
  from public.gw_users users
  where users.status = 'approved'
    and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = '藤田香織';

  if target_count <> 1 then
    raise exception '藤田香織さんを一意特定できません（%件）', target_count;
  end if;

  select users.id, coalesce(users.real_name, users.display_name)
  into fujita_id, fujita_name
  from public.gw_users users
  where users.status = 'approved'
    and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = '藤田香織';

  direct_key := 'direct:' || least(tsg_id::text, fujita_id::text) || ':' || greatest(tsg_id::text, fujita_id::text);

  select groups.id
  into direct_group_id
  from public.gw_groups groups
  where groups.type = 'chat'
    and groups.description = direct_key
  order by groups.created_at asc
  limit 1;

  if direct_group_id is null then
    insert into public.gw_groups (name, description, type, icon, created_by)
    values (tsg_name || ' / ' || fujita_name, direct_key, 'chat', '💬', tsg_id)
    returning id into direct_group_id;
  end if;

  insert into public.gw_group_members (group_id, user_id, role)
  values
    (direct_group_id, tsg_id, 'member'),
    (direct_group_id, fujita_id, 'member')
  on conflict (group_id, user_id) do update
  set role = excluded.role;

  delete from public.gw_group_members members
  where members.group_id = direct_group_id
    and members.user_id not in (tsg_id, fujita_id);

  select posts.id, posts.created_at
  into message_id, message_created_at
  from public.gw_posts posts
  where posts.group_id = direct_group_id
    and posts.user_id = tsg_id
    and posts.parent_id is null
    and posts.content = message_body
  order by posts.created_at desc
  limit 1;

  if message_id is null then
    insert into public.gw_posts (group_id, user_id, content, attachments, parent_id)
    values (direct_group_id, tsg_id, message_body, '[]'::jsonb, null)
    returning id, created_at into message_id, message_created_at;
  end if;

  update public.gw_groups groups
  set updated_at = greatest(coalesce(groups.updated_at, message_created_at), message_created_at)
  where groups.id = direct_group_id;

  select count(*)
  into target_count
  from public.gw_group_members members
  where members.group_id = direct_group_id
    and members.user_id in (tsg_id, fujita_id);

  if target_count <> 2 then
    raise exception 'DMメンバー検証に失敗しました（%件）', target_count;
  end if;

  select count(*)
  into target_count
  from public.gw_posts posts
  where posts.id = message_id
    and posts.group_id = direct_group_id
    and posts.user_id = tsg_id
    and posts.content = message_body;

  if target_count <> 1 then
    raise exception '藤田香織さんへのTSG君DM検証に失敗しました（%件）', target_count;
  end if;
end
$dm$;

commit;
