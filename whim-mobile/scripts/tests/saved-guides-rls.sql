begin;
create temporary table qa_saved_guides_context as
select (array_agg(id order by created_at))[1] as user_a,
       (array_agg(id order by created_at))[2] as user_b,
       gen_random_uuid() as approved_id, gen_random_uuid() as rejected_id
from auth.users;
grant select on qa_saved_guides_context to authenticated;
do $$
declare c record; n int; denied boolean;
begin
  select * into c from qa_saved_guides_context;
  if c.user_a is null or c.user_b is null then raise exception 'Need two existing users for isolation verification'; end if;
  insert into public.published_itineraries(id,author,title,stop_spot_ids,stop_count,status)
    values (c.approved_id,c.user_a,'Temporary bookmark QA',array['qa-only'],1,'approved'),
           (c.rejected_id,c.user_a,'Temporary rejected QA',array['qa-only'],1,'rejected');
  perform set_config('request.jwt.claim.sub',c.user_a::text,true);
  execute 'set local role authenticated';
  perform public.set_saved_guide(c.approved_id,true);
  perform public.set_saved_guide(c.approved_id,true);
  select count(*) into n from public.saved_guides where guide_id=c.approved_id;
  if n <> 1 then raise exception 'Duplicate-save check failed'; end if;
  denied := false;
  begin perform public.set_saved_guide(c.rejected_id,true);
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Rejected guide insert was allowed'; end if;
  denied := false;
  begin insert into public.saved_guides(user_id,guide_id) values(c.user_b,c.approved_id);
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Forged ownership insert was allowed'; end if;
  denied := false;
  begin update public.saved_guides set created_at=now() where guide_id=c.approved_id;
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Client update was allowed'; end if;
  perform set_config('request.jwt.claim.sub',c.user_b::text,true);
  select count(*) into n from public.saved_guides where guide_id=c.approved_id;
  if n <> 0 then raise exception 'Another account can see bookmarks'; end if;
  perform public.set_saved_guide(c.approved_id,false);
  perform public.set_saved_guide(c.approved_id,true);
  select count(*) into n from public.saved_guides where guide_id=c.approved_id;
  if n <> 1 then raise exception 'Second account save failed'; end if;
  perform set_config('request.jwt.claim.sub',c.user_a::text,true);
  select count(*) into n from public.saved_guides where guide_id=c.approved_id;
  if n <> 1 then raise exception 'Cross-account delete removed original bookmark'; end if;
  perform public.set_saved_guide(c.approved_id,false);
  perform public.set_saved_guide(c.approved_id,false);
  select count(*) into n from public.saved_guides where guide_id=c.approved_id;
  if n <> 0 then raise exception 'Idempotent removal failed'; end if;
  insert into public.blocked_users(blocked_id) values(c.user_b) on conflict do nothing;
  execute 'reset role';
  update public.published_itineraries set author=c.user_b where id=c.approved_id;
  execute 'set local role authenticated';
  denied := false;
  begin perform public.set_saved_guide(c.approved_id,true);
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Blocked creator guide was allowed'; end if;
  execute 'reset role';
  if has_table_privilege('anon','public.saved_guides','SELECT') or has_table_privilege('anon','public.saved_guides','INSERT')
     or has_function_privilege('anon','public.set_saved_guide(uuid,boolean)','EXECUTE') then
    raise exception 'Anonymous permissions were granted';
  end if;
end $$;
select 'PASS: duplicate save, own read/delete, forged ownership, rejected and blocked guides, anonymous and update denial' as checks;
rollback;
