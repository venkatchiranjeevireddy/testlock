-- =====================================================================
-- Wedding AR System — one-time Supabase setup
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- Safe to re-run (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Who may upload (the Dev App admin). Filled once, see README step 3.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- One row per image/video pair. Rows only ever exist once the files are
-- uploaded AND the tracking target containing them is published, because
-- they are created atomically by register_pair() below.
create table if not exists public.pairs (
  id          uuid primary key default gen_random_uuid(),
  label       text not null default '',
  image_path  text not null,
  video_path  text not null,
  image_width  int  not null,
  image_height int  not null,
  created_at  timestamptz not null default now()
);

-- Each upload publishes a new immutable target set (a .mind file that
-- contains EVERY pair so far). pair_ids is the ORDER of targets inside the
-- .mind file: pair_ids[1] is MindAR target index 0, and so on.
create table if not exists public.target_sets (
  version    int primary key,
  mind_path  text not null,
  pair_ids   uuid[] not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------------
alter table public.admins      enable row level security;
alter table public.pairs       enable row level security;
alter table public.target_sets enable row level security;

-- helper: is the caller an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Everyone (the Viewer App uses the anon key) may READ pairs + target sets.
drop policy if exists "public read pairs" on public.pairs;
create policy "public read pairs" on public.pairs
  for select using (true);

drop policy if exists "public read target_sets" on public.target_sets;
create policy "public read target_sets" on public.target_sets
  for select using (true);

-- Admins may read their own admin row (lets the Dev App check access).
drop policy if exists "admin reads self" on public.admins;
create policy "admin reads self" on public.admins
  for select using (user_id = auth.uid());

-- No direct insert/update/delete policies on pairs / target_sets:
-- all writes go through the functions below (security definer + admin check).
-- Belt and braces: also make the table privileges explicit (read-only for the API roles).
revoke all on public.pairs, public.target_sets, public.admins from anon, authenticated;
grant select on public.pairs, public.target_sets to anon, authenticated;
grant select on public.admins to authenticated;

-- ---------------------------------------------------------------------
-- 3. Atomic publish functions (called by the Dev App)
-- ---------------------------------------------------------------------

-- Returns the latest published version (0 when nothing is published yet).
create or replace function public.latest_version()
returns int
language sql
stable
as $$
  select coalesce(max(version), 0) from public.target_sets;
$$;

-- Registers a new pair and publishes the new target set in ONE transaction.
-- p_base_version is the version the Dev App merged on top of. If somebody
-- else published in the meantime the call fails ('version_conflict') and the
-- Dev App simply re-merges and retries; nothing is ever half-written.
create or replace function public.register_pair(
  p_base_version int,
  p_label        text,
  p_image_path   text,
  p_video_path   text,
  p_image_width  int,
  p_image_height int,
  p_mind_path    text
)
returns table (pair_id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current int;
  v_prev    uuid[];
  v_pair    uuid;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  -- serialise concurrent publishers
  lock table public.target_sets in share row exclusive mode;

  select coalesce(max(ts.version), 0) into v_current from public.target_sets ts;
  if v_current <> p_base_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  if v_current = 0 then
    v_prev := '{}';
  else
    select ts.pair_ids into v_prev from public.target_sets ts where ts.version = v_current;
  end if;

  insert into public.pairs (label, image_path, video_path, image_width, image_height)
  values (p_label, p_image_path, p_video_path, p_image_width, p_image_height)
  returning id into v_pair;

  insert into public.target_sets (version, mind_path, pair_ids)
  values (v_current + 1, p_mind_path, v_prev || v_pair);

  return query select v_pair, v_current + 1;
end;
$$;

revoke all on function public.register_pair(int, text, text, text, int, int, text) from public, anon;
grant execute on function public.register_pair(int, text, text, text, int, int, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Storage: one PUBLIC bucket (direct MP4 / image / .mind URLs).
--    Public = anyone with a file URL can read it (needed for video range
--    requests on phones). Only admins can write or delete.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wedding-ar', 'wedding-ar', true)
on conflict (id) do update set public = true;

drop policy if exists "wedding-ar admin insert" on storage.objects;
create policy "wedding-ar admin insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wedding-ar' and public.is_admin());

drop policy if exists "wedding-ar admin update" on storage.objects;
create policy "wedding-ar admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'wedding-ar' and public.is_admin());

drop policy if exists "wedding-ar admin delete" on storage.objects;
create policy "wedding-ar admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wedding-ar' and public.is_admin());

-- The Dev App must be able to read the current .mind file while signed in;
-- the bucket is public so reads work without any extra select policy.

-- ---------------------------------------------------------------------
-- 5. After running this file, make yourself admin (README step 3):
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'YOUR_EMAIL_HERE';
-- ---------------------------------------------------------------------
