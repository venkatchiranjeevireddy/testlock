#!/usr/bin/env bash
# Runs setup.sql + behavioural checks on a throwaway local Postgres (not Supabase itself).
# Usage: PSQL="psql -h /tmp/pgtest -p 54329 -U postgres" ./sql-test.sh
set -euo pipefail
PSQL=${PSQL:-"psql -h /tmp/pgtest -p 54329 -U postgres"}
DIR=$(cd "$(dirname "$0")" && pwd)
$PSQL -q -v ON_ERROR_STOP=1 -c "drop database if exists t" -c "create database t"
P="$PSQL -q -v ON_ERROR_STOP=1 -d t"
# roles are cluster-wide: recreate
$PSQL -q -c "drop role if exists anon" -c "drop role if exists authenticated" 2>/dev/null || true
$P -f "$DIR/stub.sql"
$P -f "$DIR/../setup.sql"
$P -f "$DIR/../setup.sql"   # idempotent re-run
$P -f "$DIR/checks.sql"
echo "SQL TESTS PASSED"
