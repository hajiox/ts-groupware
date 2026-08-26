-- Account-level notification center assembled from existing TSG activity.
-- Source rows remain authoritative so deleted comments, canceled tasks, and
-- removed reactions disappear without maintaining duplicate notification rows.

create table if not exists public.gw_notification_center_state (
  user_id uuid primary key references public.gw_users(id) on delete cascade,
  read_through timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gw_notification_center_state is
  'Account-level read cursor for the in-app notification center.';

alter table public.gw_notification_center_state enable row level security;
revoke all on table public.gw_notification_center_state from public, anon, authenticated;
grant all privileges on table public.gw_notification_center_state to service_role;

create index if not exists idx_gw_posts_user_created
  on public.gw_posts(user_id, created_at desc);

create index if not exists idx_gw_tasks_assignee_created_active
  on public.gw_tasks(assignee_id, created_at desc)
  where canceled_at is null;

insert into public.gw_notification_center_state (user_id, read_through)
select users.id, now()
from public.gw_users as users
on conflict (user_id) do nothing;

create or replace function public.gw_initialize_notification_center_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gw_notification_center_state (user_id, read_through)
  values (new.id, now())
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_gw_initialize_notification_center_state on public.gw_users;
create trigger trg_gw_initialize_notification_center_state
after insert on public.gw_users
for each row execute function public.gw_initialize_notification_center_state();

create or replace function public.gw_notification_center_feed(
  p_user_id uuid,
  p_limit integer default 100
)
returns table (
  event_key text,
  event_type text,
  source_id uuid,
  actor_id uuid,
  actor_name text,
  actor_picture_url text,
  group_name text,
  title text,
  summary text,
  url text,
  created_at timestamptz,
  due_date date,
  completed_at timestamptz,
  emoji text
)
language sql
stable
security definer
set search_path = public
as $$
  with notification_feed as (
    select
      'mention:' || mentions.id::text as event_key,
      'mention'::text as event_type,
      mentions.id as source_id,
      mentions.sender_id as actor_id,
      coalesce(
        nullif(sender.real_name, ''),
        nullif(sender.display_name, ''),
        nullif(mentions.sender_name, ''),
        'メンバー'
      ) as actor_name,
      sender.picture_url as actor_picture_url,
      mentions.group_name,
      '自分へのメンション'::text as title,
      left(
        regexp_replace(
          coalesce(nullif(mentions.content_snippet, ''), '（本文なし）'),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        160
      ) as summary,
      coalesce(nullif(mentions.url, ''), '/groups') as url,
      mentions.created_at,
      null::date as due_date,
      null::timestamptz as completed_at,
      null::text as emoji
    from public.gw_mentions as mentions
    left join public.gw_users as sender on sender.id = mentions.sender_id
    where mentions.mentioned_user_id = p_user_id

    union all

    select
      'task:' || tasks.id::text,
      'task'::text,
      tasks.id,
      tasks.requester_id,
      coalesce(nullif(requester.real_name, ''), nullif(requester.display_name, ''), 'メンバー'),
      requester.picture_url,
      groups.name,
      'タスク依頼'::text,
      left(
        regexp_replace(
          coalesce(nullif(posts.content, ''), '（本文なし）'),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        160
      ),
      '/board/' || tasks.group_id::text || '#post-' || tasks.post_id::text,
      tasks.created_at,
      tasks.due_date,
      tasks.completed_at,
      null::text
    from public.gw_tasks as tasks
    join public.gw_posts as posts on posts.id = tasks.post_id
    join public.gw_groups as groups on groups.id = tasks.group_id
    left join public.gw_users as requester on requester.id = tasks.requester_id
    where tasks.assignee_id = p_user_id
      and tasks.canceled_at is null

    union all

    select
      'reaction:' || reactions.id::text,
      'reaction'::text,
      reactions.id,
      reactions.user_id,
      coalesce(nullif(actor.real_name, ''), nullif(actor.display_name, ''), 'メンバー'),
      actor.picture_url,
      groups.name,
      'リアクション'::text,
      left(
        regexp_replace(
          coalesce(nullif(target_post.content, ''), 'ファイル付き投稿'),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        160
      ),
      case
        when groups.type = 'chat' then '/chat/' || target_post.group_id::text
        else '/board/' || target_post.group_id::text || '#post-' || coalesce(target_post.parent_id, target_post.id)::text
      end,
      reactions.created_at,
      null::date,
      null::timestamptz,
      reactions.emoji
    from public.gw_reactions as reactions
    join public.gw_posts as target_post on target_post.id = reactions.post_id
    join public.gw_groups as groups on groups.id = target_post.group_id
    left join public.gw_users as actor on actor.id = reactions.user_id
    where target_post.user_id = p_user_id
      and reactions.user_id <> p_user_id

    union all

    select
      'comment:' || comments.id::text,
      'comment'::text,
      comments.id,
      comments.user_id,
      coalesce(nullif(actor.real_name, ''), nullif(actor.display_name, ''), 'メンバー'),
      actor.picture_url,
      groups.name,
      case
        when reply_target.user_id = p_user_id then '自分のコメントへの返信'::text
        else '自分の投稿へのコメント'::text
      end,
      left(
        regexp_replace(
          coalesce(nullif(comments.content, ''), 'ファイル付きコメント'),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        160
      ),
      '/board/' || comments.group_id::text || '#post-' || root_post.id::text,
      comments.created_at,
      null::date,
      null::timestamptz,
      null::text
    from public.gw_posts as comments
    join public.gw_posts as root_post on root_post.id = comments.parent_id
    left join public.gw_posts as reply_target on reply_target.id = comments.reply_to_id
    join public.gw_groups as groups on groups.id = comments.group_id and groups.type = 'board'
    left join public.gw_users as actor on actor.id = comments.user_id
    where (root_post.user_id = p_user_id or reply_target.user_id = p_user_id)
      and comments.user_id <> p_user_id
      and not exists (
        select 1
        from public.gw_mentions as mentions
        where mentions.mentioned_user_id = p_user_id
          and mentions.post_id = comments.id
      )
  )
  select
    feed.event_key,
    feed.event_type,
    feed.source_id,
    feed.actor_id,
    feed.actor_name,
    feed.actor_picture_url,
    feed.group_name,
    feed.title,
    feed.summary,
    feed.url,
    feed.created_at,
    feed.due_date,
    feed.completed_at,
    feed.emoji
  from notification_feed as feed
  order by feed.created_at desc, feed.event_key desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

create or replace function public.gw_mark_notification_center_read(
  p_user_id uuid,
  p_read_through timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_read_through timestamptz := least(coalesce(p_read_through, now()), now());
  v_result timestamptz;
begin
  insert into public.gw_notification_center_state (user_id, read_through, updated_at)
  values (p_user_id, v_read_through, now())
  on conflict (user_id) do update
  set read_through = greatest(public.gw_notification_center_state.read_through, excluded.read_through),
      updated_at = now()
  returning read_through into v_result;

  return v_result;
end;
$$;

revoke all on function public.gw_notification_center_feed(uuid, integer) from public, anon, authenticated;
revoke all on function public.gw_mark_notification_center_read(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.gw_initialize_notification_center_state() from public, anon, authenticated;
grant execute on function public.gw_notification_center_feed(uuid, integer) to service_role;
grant execute on function public.gw_mark_notification_center_read(uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
