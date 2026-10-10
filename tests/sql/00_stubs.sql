-- Minimal stand-ins for the parts of Supabase the migration depends on, so the
-- real migration can be exercised on a plain PostgreSQL instance.
-- Run this FIRST, then the migration, then 10_scenario.sql.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase reads the caller's id from the request JWT claims.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id     text primary key,
  name   text,
  public boolean default false
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text,
  owner     uuid
);

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/')
$$;

-- Assertion helper (security definer so the authenticated role can call it).
create or replace function public._t_assert(cond boolean, msg text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if cond is not true then
    raise exception 'ASSERT FAILED: %', msg;
  end if;
  raise notice 'PASS: %', msg;
end $$;

-- Scratch table so a second user can hold a reference to the first user's ids
-- in order to prove cross-user access is refused.
create table if not exists public._t_ids (name text primary key, val uuid);

grant usage on schema public to authenticated;
grant execute on function public._t_assert(boolean, text) to authenticated;
grant select, insert on public._t_ids to authenticated;
