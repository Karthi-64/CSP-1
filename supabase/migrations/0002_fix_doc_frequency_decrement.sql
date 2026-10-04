-- ============================================================================
-- Cloud Files — fix doc-frequency decrement on file deletion
-- ============================================================================
--
-- The down-weighted Jaccard in weightedJaccard() uses
--   weight(s) = ln(N / df(s))
-- If shingle_doc_frequency.doc_count is never decremented when a file is
-- deleted, the IDF weights drift upward over time and can even go negative
-- (ln(N/df) when df > N). This migration fixes that.
--
-- A SINGLE uploaded file can repeat the same shingle_hash across many
-- file_shingles rows (overlapping 5-word windows), so the trigger MUST be
-- STATEMENT-level (not row-level) and must iterate the OLD TABLE transition
-- with REFERENCING OLD TABLE AS deleted_rows, decrementing once per
-- DISTINCT (user_id, shingle_hash) — not once per row.
--
-- Style follows the existing ref_count trigger / delete_logical_file path:
--   - security definer so the suppression role owns the work
--   - set search_path = public
--   - cascade-safe, set-based DELETE from the transition table

create or replace function public.decrement_shingle_doc_frequency()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.shingle_doc_frequency s
  using (
    select distinct user_id, shingle_hash
      from public.file_shingles
     where id in (select id from deleted_rows)
  ) d
  where s.user_id = d.user_id
    and s.shingle_hash = d.shingle_hash;

  update public.shingle_doc_frequency s
     set doc_count = s.doc_count - 1
   from (
     select distinct user_id, shingle_hash
       from public.file_shingles
      where id in (select id from deleted_rows)
   ) d
   where s.user_id = d.user_id
     and s.shingle_hash = d.shingle_hash
     and s.doc_count > 1;
end;
$$;

drop trigger if exists trg_shingle_doc_frequency_deleted on public.file_shingles;
create trigger trg_shingle_doc_frequency_deleted
  after delete on public.file_shingles
  for each statement
  execute function public.decrement_shingle_doc_frequency();
