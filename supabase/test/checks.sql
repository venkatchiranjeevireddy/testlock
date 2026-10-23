\set ON_ERROR_STOP on
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','admin@x.test'), ('00000000-0000-0000-0000-0000000000b2','rando@x.test');
insert into public.admins values ('00000000-0000-0000-0000-0000000000a1');

create or replace function pg_temp.expect_fail(sql text, pattern text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if sqlerrm like pattern then return; end if;
    raise exception 'wrong error for [%]: %', sql, sqlerrm;
  end;
  raise exception 'expected failure but succeeded: %', sql;
end $$;

-- anon: can read, cannot call register_pair, cannot write
set role anon;
select count(*) from public.pairs;
select pg_temp.expect_fail($$select * from public.register_pair(0,'x','i','v',1,1,'m')$$, '%permission denied%');
select pg_temp.expect_fail($$insert into public.pairs(image_path,video_path,image_width,image_height) values('a','b',1,1)$$, '%permission denied%');
reset role;

-- non-admin authenticated user rejected
set role authenticated; set app.uid = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.expect_fail($$select * from public.register_pair(0,'x','i','v',1,1,'m')$$, '%not_admin%');
select pg_temp.expect_fail($$insert into storage.objects(bucket_id,name) values('wedding-ar','evil')$$, '%row-level security%');
reset role;

-- admin: publish three pairs in sequence; order + versions correct
set role authenticated; set app.uid = '00000000-0000-0000-0000-0000000000a1';
select pair_id as p1, version from public.register_pair(0,'one','images/1.jpg','videos/1.mp4',100,50,'targets/v1.mind') \gset
select pair_id as p2, version from public.register_pair(1,'two','images/2.jpg','videos/2.mp4',100,50,'targets/v2.mind') \gset
select pair_id as p3, version from public.register_pair(2,'three','images/3.jpg','videos/3.mp4',100,50,'targets/v3.mind') \gset
insert into storage.objects(bucket_id,name) values('wedding-ar','images/1.jpg');   -- admin may upload
-- stale base version => version_conflict, and NOTHING is written
select pg_temp.expect_fail($$select * from public.register_pair(1,'stale','i','v',1,1,'targets/stale.mind')$$, '%version_conflict%');
reset role;

-- anon (viewer) sees exactly the 3 pairs and the latest set with the correct order
set role anon;
do $$ declare s record; n int; begin
  select count(*) into n from public.pairs;               if n <> 3 then raise exception 'pairs=%', n; end if;
  select count(*) into n from public.target_sets;         if n <> 3 then raise exception 'sets=%', n; end if;
  select * into s from public.target_sets order by version desc limit 1;
  if s.version <> 3 or s.mind_path <> 'targets/v3.mind' or array_length(s.pair_ids,1) <> 3 then raise exception 'bad latest set %', s; end if;
  if (select label from public.pairs where id = s.pair_ids[1]) <> 'one'
  or (select label from public.pairs where id = s.pair_ids[2]) <> 'two'
  or (select label from public.pairs where id = s.pair_ids[3]) <> 'three' then raise exception 'order wrong'; end if;
end $$;
reset role;
select 'ok';
