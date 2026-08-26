begin;

alter table public.gw_groups
  add column if not exists posting_disabled boolean not null default false;

alter table public.gw_groups
  add column if not exists posting_disabled_message text;

comment on column public.gw_groups.posting_disabled is
  'True when new posts, comments, and content edits are disabled for this group.';

comment on column public.gw_groups.posting_disabled_message is
  'User-facing reason and alternate workflow shown when group posting is disabled.';

create or replace function public.gw_enforce_group_posting_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_disabled boolean := false;
  target_message text;
begin
  select
    coalesce(groups.posting_disabled, false),
    nullif(btrim(groups.posting_disabled_message), '')
  into target_disabled, target_message
  from public.gw_groups groups
  where groups.id = new.group_id;

  if target_disabled then
    raise exception using
      errcode = 'P0001',
      message = coalesce(target_message, 'この掲示板は閲覧専用です');
  end if;

  return new;
end;
$$;

drop trigger if exists gw_posts_enforce_group_posting_policy on public.gw_posts;

create trigger gw_posts_enforce_group_posting_policy
before insert or update of group_id, content, attachments, parent_id, reply_to_id
on public.gw_posts
for each row
execute function public.gw_enforce_group_posting_policy();

do $policy$
declare
  target_count integer;
begin
  select count(*)
  into target_count
  from public.gw_groups groups
  where groups.id = '5f347bce-46bc-428b-bd7d-1c10aa62415c'::uuid
    and groups.name = 'TS（有給管理）'
    and groups.type = 'board';

  if target_count <> 1 then
    raise exception 'TS（有給管理）掲示板を一意特定できません（%件）', target_count;
  end if;

  update public.gw_groups
  set
    posting_disabled = true,
    posting_disabled_message = 'この掲示板は閲覧専用です。有給申請は下メニュー「管理」→「有給申請」から行ってください。',
    updated_at = now()
  where id = '5f347bce-46bc-428b-bd7d-1c10aa62415c'::uuid;
end
$policy$;

commit;
