begin;

do $dm$
declare
  tsg_id uuid;
  tsg_name text;
  recipient_key text;
  recipient_id uuid;
  recipient_display_name text;
  direct_key text;
  direct_group_id uuid;
  message_body text;
  message_id uuid;
  message_created_at timestamptz;
  target_count integer;
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

  for recipient_key, message_body in
    select targets.recipient_key, targets.message_body
    from (values
      (
        '佐藤葵（フロア）'::text,
        $aoi$佐藤葵さん

TSGくんです。
「TS（有給管理）」への8月13日（全休）・14日（半休）の投稿を確認しました。この2日分は専用システムでも申請・承認済みのため、今回は再申請不要です。

8月1日から有給申請は専用システムへ移行しています。今後は次の手順で申請してください。

1. 下メニュー「管理」を開く
2. 「有給申請」を開く
3. 「有給申請を開く」を押す
4. 取得日と全休・半休、必要に応じて理由を入力
5. 「申請する」を押す

所属管理者の承認後に確定し、残日数へ反映されます。「TS（有給管理）」掲示板への投稿だけでは申請になりません。$aoi$::text
      ),
      (
        '武藤志保'::text,
        $muto$武藤さん

TSGくんです。
「TS（有給管理）」への8月28日の有給希望を確認しました。掲示板への投稿だけでは、有給申請・承認・残日数への反映は行われません。

現在8月28日は、確定シフト上で「休み希望」となっており勤務枠がありません。まず所属管理者へ「8月28日を有給へ変更したい」と連絡し、勤務日の調整後に次の手順で申請してください。

1. 下メニュー「管理」を開く
2. 「有給申請」を開く
3. 「有給申請を開く」を押す
4. 8月28日と「有給（全休）」を選ぶ
5. 理由を入力し、「申請する」を押す

「確定シフト上の勤務日ではありません」と表示される場合は、所属管理者へその画面を伝えてください。$muto$::text
      )
    ) as targets(recipient_key, message_body)
  loop
    select count(*)
    into target_count
    from public.gw_users users
    where users.status = 'approved'
      and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = recipient_key;

    if target_count <> 1 then
      raise exception '%さんを一意特定できません（%件）', recipient_key, target_count;
    end if;

    select users.id, coalesce(users.real_name, users.display_name)
    into recipient_id, recipient_display_name
    from public.gw_users users
    where users.status = 'approved'
      and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = recipient_key;

    select count(*)
    into target_count
    from public.gw_posts posts
    join public.gw_groups groups on groups.id = posts.group_id
    where groups.id = '5f347bce-46bc-428b-bd7d-1c10aa62415c'::uuid
      and groups.name = 'TS（有給管理）'
      and posts.user_id = recipient_id
      and posts.parent_id is null
      and posts.created_at >= timestamptz '2026-08-01 00:00:00+09';

    if target_count < 1 then
      raise exception '%さんの制度開始後の有給掲示板投稿を確認できません', recipient_key;
    end if;

    direct_key := 'direct:' || least(tsg_id::text, recipient_id::text) || ':' || greatest(tsg_id::text, recipient_id::text);
    direct_group_id := null;
    message_id := null;
    message_created_at := null;

    select groups.id
    into direct_group_id
    from public.gw_groups groups
    where groups.type = 'chat'
      and groups.description = direct_key
    order by groups.created_at asc
    limit 1;

    if direct_group_id is null then
      insert into public.gw_groups (name, description, type, icon, created_by)
      values (tsg_name || ' / ' || recipient_display_name, direct_key, 'chat', '💬', tsg_id)
      returning id into direct_group_id;
    end if;

    insert into public.gw_group_members (group_id, user_id, role)
    values
      (direct_group_id, tsg_id, 'member'),
      (direct_group_id, recipient_id, 'member')
    on conflict (group_id, user_id) do update
    set role = excluded.role;

    delete from public.gw_group_members members
    where members.group_id = direct_group_id
      and members.user_id not in (tsg_id, recipient_id);

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
      and members.user_id in (tsg_id, recipient_id);

    if target_count <> 2 then
      raise exception '%さんのDMメンバー検証に失敗しました（%件）', recipient_key, target_count;
    end if;

    select count(*)
    into target_count
    from public.gw_posts posts
    where posts.id = message_id
      and posts.group_id = direct_group_id
      and posts.user_id = tsg_id
      and posts.content = message_body;

    if target_count <> 1 then
      raise exception '%さんへのTSG君DM検証に失敗しました（%件）', recipient_key, target_count;
    end if;
  end loop;
end
$dm$;

commit;
