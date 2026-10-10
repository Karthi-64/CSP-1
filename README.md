# Cloud Files — personal file manager with two-tier deduplication

A personal cloud file manager on Supabase. Deduplication happens in two tiers:

- **Tier 1 — byte dedup.** Every upload is SHA-256 hashed. If the same bytes
  already exist *for that user*, no new bytes are stored: a new logical file
  points at the existing physical blob and its `ref_count` is incremented.
- **Tier 2 — near-duplicate detection.** Extracted text is broken into
  overlapping 5-word shingles and compared with a down-weighted Jaccard score,
  combined with filename edit-distance, to flag *possible* duplicates for a
  human to review.

**No AI/LLM is used anywhere.** Every score is a plain formula: SHA-256,
Levenshtein distance, weighted Jaccard over shingle sets, and Myers diff
(`diff` npm package). No embeddings, no semantic similarity, no MinHash, no OCR,
and no cross-user comparison — uniqueness on `physical_blobs` is
`(user_id, sha256_hash)` together, on purpose.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite + React + TypeScript (`diff` for the comparison view) |
| Metadata | Supabase Postgres, RLS scoped to `auth.uid()` |
| Bytes | Supabase Storage (private `files` bucket) |
| Pipeline | Supabase Edge Functions (Deno) |

## One-time setup

The repo connects to your Supabase project through environment variables and the
Supabase CLI — no credentials are committed.

```bash
npm install
cp .env.example .env.local         # fill in URL + anon key
```

Then apply the schema and deploy the functions:

```bash
# link the local CLI to your project (one time)
npx supabase link --project-ref <your-project-ref>

# push the migration (tables, RLS, triggers, RPCs, storage bucket + policies)
npx supabase db push

# deploy the two Edge Functions
npx supabase functions deploy process-upload
npx supabase functions deploy delete-file
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
into Edge Functions automatically; the pipeline deliberately runs with the
**caller's JWT** so Row-Level Security applies end-to-end.

Run the frontend:

```bash
npm run dev
```

## Data model

| Table | Purpose |
| --- | --- |
| `physical_blobs` | One row per unique `(user_id, sha256_hash)`; holds `ref_count`. |
| `logical_files` | One row per uploaded filename, pointing at a blob. |
| `logical_files_text` | Extracted text + `extraction_ok` + confidence floor. |
| `file_shingles` | Overlapping 5-word shingle hashes with `start_offset`. |
| `shingle_doc_frequency` | Per-user `(user_id, shingle_hash) → doc_count` for IDF weighting. |
| `near_duplicate_pairs` | Tier-2 results with `content_score`, `filename_score`, `composite_score`, `confidence`, `status`. |

## Upload pipeline (Edge Function `process-upload`)

1. Stream the file, compute SHA-256.
2. **Tier 1:** insert `physical_blobs(user_id, sha256_hash)`. On conflict,
   increment `ref_count`, create a new `logical_files` row, stop.
3. New blob → upload bytes to Storage; read the page/slide count from metadata.
4. Extract text: unzip+parse XML text nodes for `.docx/.pptx/.xlsx`, extract the
   text layer for `.pdf`, read directly for `.txt/.md/.csv`.
5. **Confidence check.** `expected_min_chars` uses per-format floors —
   1,500 chars/page (`.docx/.pdf`), 150 chars/slide (`.pptx`), chars-per-cell
   (`.xlsx`). If extracted chars < 20% of the floor, set `extraction_ok = false`
   and skip to metadata-only comparison.
6. On success: 5-word overlapping shingles (64-bit FNV-1a) with `start_offset`,
   then batch-upsert `shingle_doc_frequency`
   (`ON CONFLICT DO UPDATE doc_count = doc_count + 1`).
7. **Candidate generation.** Above ~2,000 files, prefilter to the same extension
   and an adjacent size bucket (`floor(ln(size)/ln(1.2))`, ±1). Below that,
   compare against every other file.
8. **Scoring.**
   - `filename_score = 1 − normalized Levenshtein(stem_a, stem_b)`.
   - `content_score` = down-weighted Jaccard, `weight(s) = ln(N / df(s))`; if
     `N < 10`, plain Jaccard with `confidence = 'provisional'`.
   - `composite = 0.7·content + 0.3·filename`, else `filename` alone with
     `confidence = 'metadata-only'`.
   - Flag if `composite ≥ 0.55` (content available) or `filename_score ≥ 0.80`.
9. Insert into `near_duplicate_pairs` with `status = 'pending'`.

## Frontend

- **Files** — filename, size, upload date, a `Shared storage ×N` badge for Tier-1
  hits, and a `N possible dups` badge for pending flags.
- **Duplicates** — pending pairs with both filenames, composite score as a
  percentage, and a confidence tag that is *always* shown ("High confidence" /
  "Metadata only — content couldn't be compared" / "Provisional — still learning
  your library"). A bare "duplicate" label is never rendered.
- **Compare** — word-level diff for content-compared pairs, plus 1–2 matched
  passages sliced ~100 chars around a shared shingle's `start_offset`.
  Metadata-only pairs skip the diff and show size/date/page deltas plus the
  reason. Actions: keep both (dismiss), rename A/B, or delete A/B behind a
  two-step confirm.
- **Dashboard** — logical files, physical blobs, bytes uploaded vs. stored, dedup
  ratio, pending reviews.

Deleting a logical file calls the transactional `delete_logical_file` RPC: a
trigger decrements the blob's `ref_count`, and the `delete-file` function removes
the stored object only when the count reaches 0.

## Testing

The similarity math and the database guarantees are both covered by executable
checks — no Supabase project required.

```bash
npm test        # scoring, shingling, hashing, confidence floors, formatting
npm run test:sql # applies the migration to a scratch Postgres and asserts RLS/dedup
```

`npm test` (Node's built-in runner) drives the **real** pipeline functions in
[`supabase/functions/_shared/score.ts`](supabase/functions/_shared/score.ts):
SHA-256 vectors, 64-bit shingle hashing staying inside signed-bigint range,
overlapping-window offsets, Levenshtein, the down-weighted Jaccard (including
that a ubiquitous shingle scores zero), the `N < 10` provisional fallback, the
composite formula, and every flag/confidence boundary.

`npm run test:sql` creates a scratch database, installs minimal Supabase stubs
(`auth.uid()`, `storage.foldername`, the `authenticated` role), applies the real
migration, then asserts — as two different users — that the same SHA-256 may
exist for two users but not twice within one, that RLS blocks cross-user reads,
inserts and deletes, that `ref_count` decrements and the blob (and only the
blob) is freed at zero, and that document frequency is additive and per-user.

## Explicit non-goals (this build)

No automatic document merging. No AI/LLM calls. No embeddings/semantic
similarity. No MinHash sketching. No OCR. No cross-user dedup or comparison,
ever.
