-- ============================================================================
-- Cloud Files — fix doc-frequency decrement on file deletion
-- ============================================================================

create or replace function public.decrement_shingle_doc_frequency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  with distinct_deleted as (
    select user_id, shingle_hash, count(distinct logical_file_id) as n
      from deleted_rows
     group by user_id, shingle_hash
  )
  update public.shingle_doc_frequency s
     set doc_count = s.doc_count - d.n
    from distinct_deleted d
   where s.user_id = d.user_id
     and s.shingle_hash = d.shingle_hash;

  delete from public.shingle_doc_frequency
   where doc_count <= 0;

  return null;
end;
$$;

drop trigger if exists trg_shingle_doc_frequency_deleted on public.file_shingles;
create trigger trg_shingle_doc_frequency_deleted
  after delete on public.file_shingles
  referencing old table as deleted_rows
  for each statement
  execute function public.decrement_shingle_doc_frequency();