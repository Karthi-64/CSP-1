-- ============================================================================
-- Cloud Files — two-tier deduplication schema
-- All comparison logic is plain hashing / set similarity / weighted scoring.
-- No AI, no embeddings, no cross-user anything.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- TIER 1: physical_blobs — one row per unique (user, sha256) byte object.
-- The uniqueness constraint is per-user ON PURPOSE. Dedup never crosses users.
-- ---------------------------------------------------------------------------
create table if not exists public.physical_blobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  sha256_hash   text not null,
  storage_path  text not null,
  size_bytes    bigint not null,
  ref_count     integer not null default 1,
  created_at    timestamptz not null default now(),
  constraint physical_blobs_user_hash_key unique (user_id, sha256_hash)
);

create index if not exists physical_blobs_user_idx on public.physical_blobs (user_id);

-- ---------------------------------------------------------------------------
-- logical_files — one row per filename a user uploaded (Tier 2 candidates).
-- ---------------------------------------------------------------------------
create table if not exists public.logical_files (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  blob_id        uuid not null references public.physical_blobs(id) on delete restrict,
  filename       text not null,
  filename_stem  text not null,
  extension      text not null,
  size_bytes     bigint not null,
  page_count     integer,
  uploaded_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index if not exists logical_files_user_idx on public.logical_files (user_id);
create index if not exists logical_files_user_ext_idx on public.logical_files (user_id, extension);
create index if not exists logical_files_blob_idx on public.logical_files (blob_id);

-- ---------------------------------------------------------------------------
-- logical_files_text — extracted text + extraction confidence, one per file.
-- ---------------------------------------------------------------------------
create table if not exists public.logical_files_text (
  logical_file_id    uuid primary key references public.logical_files(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  extracted_text     text,
  extraction_ok      boolean not null default false,
  expected_min_chars integer not null default 0,
  actual_chars       integer not null default 0,
  extraction_reason  text,
  created_at         timestamptz not null default now()
);

create index if not exists logical_files_text_user_idx on public.logical_files_text (user_id);

-- ---------------------------------------------------------------------------
-- file_shingles — overlapping 5-word windows; start_offset powers matched-
-- sentence evidence in the comparison view.
-- ---------------------------------------------------------------------------
create table if not exists public.file_shingles (
  id              bigint generated always as identity primary key,
  logical_file_id uuid not null references public.logical_files(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  shingle_hash    bigint not null,
  start_offset    integer not null,
  created_at      timestamptz not null default now()
);

create index if not exists file_shingles_file_idx on public.file_shingles (logical_file_id);
create index if not exists file_shingles_user_hash_idx on public.file_shingles (user_id, shingle_hash);

-- ---------------------------------------------------------------------------
-- shingle_doc_frequency — per-user document frequency for down-weighting
-- common content: weight(s) = ln(N / df(s)).
-- ---------------------------------------------------------------------------
create table if not exists public.shingle_doc_frequency (
  user_id      uuid not null references auth.users(id) on delete cascade,
  shingle_hash bigint not null,
  doc_count    integer not null default 0,
  primary key (user_id, shingle_hash)
);

-- ---------------------------------------------------------------------------
-- near_duplicate_pairs — Tier 2 results. `confidence` ALWAYS accompanies a
-- score so the UI can never show a bare "duplicate" label.
--   high          -> content was compared and N >= 10
--   provisional   -> content compared but N < 10 (library still tiny)
--   metadata-only -> extraction failed, only filename/size compared
-- ---------------------------------------------------------------------------
create table if not exists public.near_duplicate_pairs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  file_a_id       uuid not null references public.logical_files(id) on delete cascade,
  file_b_id       uuid not null references public.logical_files(id) on delete cascade,
  content_score   double precision,
  filename_score  double precision not null,
  composite_score double precision not null,
  confidence      text not null check (confidence in ('high', 'provisional', 'metadata-only')),
  status          text not null default 'pending' check (status in ('pending', 'kept', 'resolved')),
  created_at      timestamptz not null default now(),
  constraint near_dup_pair_distinct check (file_a_id <> file_b_id),
  constraint near_dup_pair_ordered unique (file_a_id, file_b_id)
);

create index if not exists near_dup_user_status_idx on public.near_duplicate_pairs (user_id, status);

-- ============================================================================
-- Row-Level Security — every table scoped to auth.uid()
-- ============================================================================
alter table public.physical_blobs          enable row level security;
alter table public.logical_files            enable row level security;
alter table public.logical_files_text       enable row level security;
alter table public.file_shingles            enable row level security;
alter table public.shingle_doc_frequency    enable row level security;
alter table public.near_duplicate_pairs     enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'physical_blobs','logical_files','logical_files_text',
    'file_shingles','shingle_doc_frequency','near_duplicate_pairs'
  ]
  loop
    execute format('drop policy if exists %I_owner_all on public.%I', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all
         using (user_id = auth.uid())
         with check (user_id = auth.uid())', t, t);
  end loop;
end $$;

-- ============================================================================
-- Triggers / functions
-- ============================================================================

-- Decrement a blob's ref_count whenever a logical file is deleted.
create or replace function public.on_logical_file_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.physical_blobs
     set ref_count = ref_count - 1
   where id = old.blob_id;
  return old;
end;
$$;

drop trigger if exists trg_logical_file_deleted on public.logical_files;
create trigger trg_logical_file_deleted
after delete on public.logical_files
for each row execute function public.on_logical_file_delete();

-- Transactional delete: decrements ref_count via the trigger above and, only
-- when the count reaches 0, removes the physical_blobs row. Returns the
-- storage path (if any) so the caller can remove the stored object.
create or replace function public.delete_logical_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blob_id  uuid;
  v_path     text;
  v_remaining integer;
begin
  select blob_id into v_blob_id
    from public.logical_files
   where id = p_file_id and user_id = auth.uid();

  if v_blob_id is null then
    raise exception 'logical file not found or not owned by caller';
  end if;

  delete from public.logical_files where id = p_file_id and user_id = auth.uid();

  select ref_count, storage_path into v_remaining, v_path
    from public.physical_blobs where id = v_blob_id;

  if v_remaining is null then
    -- blob already gone (shouldn't happen given FK restrict)
    return jsonb_build_object('deleted', true, 'blob_deleted', false, 'storage_path', null);
  end if;

  if v_remaining <= 0 then
    delete from public.physical_blobs where id = v_blob_id;
    return jsonb_build_object('deleted', true, 'blob_deleted', true, 'storage_path', v_path);
  end if;

  return jsonb_build_object('deleted', true, 'blob_deleted', false, 'storage_path', null);
end;
$$;

-- Atomic ref_count increment used by the upload pipeline on a Tier-1 hit.
create or replace function public.increment_blob_ref(p_blob_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.physical_blobs
     set ref_count = ref_count + 1
   where id = p_blob_id and user_id = auth.uid()
  returning ref_count into v_count;
  return v_count;
end;
$$;

-- Batch doc-frequency bump for a freshly shingled file.
-- Hashes arrive as text so 64-bit values survive the JS/JSON round-trip.
-- Scope is always auth.uid(); callers cannot touch another user's rows.
create or replace function public.bump_shingle_doc_frequency(p_hashes text[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.shingle_doc_frequency (user_id, shingle_hash, doc_count)
  select auth.uid(), h::bigint, 1 from unnest(p_hashes) as h
  on conflict (user_id, shingle_hash)
  do update set doc_count = public.shingle_doc_frequency.doc_count + 1;
$$;

-- Read document frequencies for a set of shingle hashes (text in/out).
create or replace function public.get_doc_frequencies(p_hashes text[])
returns table(shingle_hash text, doc_count integer)
language sql
security definer
set search_path = public
as $$
  select s.shingle_hash::text, s.doc_count
    from public.shingle_doc_frequency s
   where s.user_id = auth.uid()
     and s.shingle_hash = any (p_hashes::bigint[]);
$$;

-- Read shingles + offsets for a set of files (text hashes out).
create or replace function public.get_file_shingles(p_file_ids uuid[])
returns table(logical_file_id uuid, shingle_hash text, start_offset integer)
language sql
security definer
set search_path = public
as $$
  select f.logical_file_id, f.shingle_hash::text, f.start_offset
    from public.file_shingles f
   where f.user_id = auth.uid()
     and f.logical_file_id = any (p_file_ids);
$$;

-- Number of distinct files this user has shingled (N in the IDF weight).
create or replace function public.shingled_file_count()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(distinct logical_file_id)::int
    from public.file_shingles
   where user_id = auth.uid();
$$;

grant execute on function public.delete_logical_file(uuid)         to authenticated;
grant execute on function public.increment_blob_ref(uuid)          to authenticated;
grant execute on function public.shingled_file_count()             to authenticated;
grant execute on function public.get_doc_frequencies(text[])       to authenticated;
grant execute on function public.get_file_shingles(uuid[])         to authenticated;
grant execute on function public.bump_shingle_doc_frequency(text[]) to authenticated;

-- ============================================================================
-- Storage bucket + owner-scoped policies (folder name = user id)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

drop policy if exists "files_owner_select" on storage.objects;
create policy "files_owner_select" on storage.objects for select
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "files_owner_insert" on storage.objects;
create policy "files_owner_insert" on storage.objects for insert
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "files_owner_update" on storage.objects;
create policy "files_owner_update" on storage.objects for update
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "files_owner_delete" on storage.objects;
create policy "files_owner_delete" on storage.objects for delete
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
