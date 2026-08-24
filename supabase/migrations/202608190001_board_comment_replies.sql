alter table public.gw_posts
  add column if not exists reply_to_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'gw_posts_reply_to_id_fkey'
      and conrelid = 'public.gw_posts'::regclass
  ) then
    alter table public.gw_posts
      add constraint gw_posts_reply_to_id_fkey
      foreign key (reply_to_id)
      references public.gw_posts(id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_gw_posts_reply_to_id
  on public.gw_posts (reply_to_id)
  where reply_to_id is not null;

comment on column public.gw_posts.reply_to_id is
  'Immediate comment being replied to. parent_id continues to point to the root board post.';
