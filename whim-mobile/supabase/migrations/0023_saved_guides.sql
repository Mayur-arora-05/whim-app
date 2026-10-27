-- Private account bookmarks. 0022 was a removed leave-room policy draft.
-- Applied to production 2026-10-03 with Pranjal's explicit go (verified: table, RLS, RPC security invoker).
begin;
create table if not exists public.saved_guides (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  guide_id uuid not null references public.published_itineraries(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, guide_id)
);
alter table public.saved_guides enable row level security;
revoke all on public.saved_guides from anon, authenticated;
grant select, insert, delete on public.saved_guides to authenticated;

drop policy if exists "saved_guides: read own" on public.saved_guides;
create policy "saved_guides: read own" on public.saved_guides for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "saved_guides: insert own approved" on public.saved_guides;
create policy "saved_guides: insert own approved" on public.saved_guides for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.published_itineraries i
    where i.id = guide_id and i.status = 'approved' and not exists (
      select 1 from public.blocked_users b where b.blocker_id = (select auth.uid()) and b.blocked_id = i.author
    )
  ));
drop policy if exists "saved_guides: delete own" on public.saved_guides;
create policy "saved_guides: delete own" on public.saved_guides for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.set_saved_guide(p_guide_id uuid, p_saved boolean)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_guide_id is null or p_saved is null then raise exception 'Invalid bookmark'; end if;
  if p_saved then
    insert into public.saved_guides(guide_id) values (p_guide_id)
    on conflict (user_id, guide_id) do nothing;
  else
    delete from public.saved_guides where user_id = auth.uid() and guide_id = p_guide_id;
  end if;
end;
$$;
revoke all on function public.set_saved_guide(uuid, boolean) from public, anon;
grant execute on function public.set_saved_guide(uuid, boolean) to authenticated;
commit;
