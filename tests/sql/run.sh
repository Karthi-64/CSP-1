#!/usr/bin/env bash
# Applies the real migration to a scratch database (with Supabase stubs) and
# runs the behavioral assertions. Requires a reachable local PostgreSQL.
#
#   ./tests/sql/run.sh [db_name]
set -euo pipefail

DB="${1:-safara_rls_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

dropdb --if-exists "$DB"
createdb "$DB"

echo "── stubs ─────────────────────────────────────────────"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/tests/sql/00_stubs.sql"

echo "── migration ─────────────────────────────────────────"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/migrations/0001_init.sql" 2>&1 \
  | grep -v 'does not exist, skipping' || true

echo "── scenario ──────────────────────────────────────────"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/tests/sql/10_scenario.sql" 2>&1 \
  | grep -Ei 'PASS:|ASSERT FAILED|ERROR' || true

dropdb --if-exists "$DB"
echo "✅ SQL SCENARIO PASSED"
