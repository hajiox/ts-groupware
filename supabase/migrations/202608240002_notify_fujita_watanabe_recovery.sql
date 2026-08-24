begin;

do $dm$
declare
  tsg_id uuid;
  tsg_name text;
  recipient_id uuid;
  recipient_name text;
  recipient_display_name text;
  direct_key text;
  direct_group_id uuid;
  message_id uuid;
  message_created_at timestamptz;
  target_count integer;
  message_body constant text := $message$TSGの一部機能が、システム更新時の不備で一時正常に動作しない状態となっていました。
現在は勤怠・管理・シフトを含め復旧済みです。ご迷惑をおかけしました。$message$;
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

  foreach recipient_name in array array['藤田香織', '渡部瞳'] loop
    select count(*)
    into target_count
    from public.gw_users users
    where users.status = 'approved'
      and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = recipient_name;

    if target_count <> 1 then
      raise exception '%さんを一意特定できません（%件）', recipient_name, target_count;
    end if;

    select users.id, coalesce(users.real_name, users.display_name)
    into recipient_id, recipient_display_name
    from public.gw_users users
    where users.status = 'approved'
      and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]', '', 'g') = recipient_name;

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
      insert into public.gw_groups (
        name,
        description,
        type,
        icon,
        created_by
      ) values (
        tsg_name || ' / ' || recipient_display_name,
        direct_key,
        'chat',
        '💬',
        tsg_id
      )
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
      insert into public.gw_posts (
        group_id,
        user_id,
        content,
        attachments,
        parent_id
      ) values (
        direct_group_id,
        tsg_id,
        message_body,
        '[]'::jsonb,
        null
      )
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
      raise exception '%さんのDMメンバー検証に失敗しました（%件）', recipient_name, target_count;
    end if;

    select count(*)
    into target_count
    from public.gw_posts posts
    where posts.id = message_id
      and posts.group_id = direct_group_id
      and posts.user_id = tsg_id
      and posts.content = message_body;

    if target_count <> 1 then
      raise exception '%さんへのTSG君DM検証に失敗しました（%件）', recipient_name, target_count;
    end if;
  end loop;
end
$dm$;

commit;
