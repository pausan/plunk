#!/usr/bin/env bash
#
# Contact fields benchmark. Measures GET /contacts/fields -- that is,
# ContactService.getAvailableFields() -- against a synthetic corpus of millions of
# contacts carrying ~30 custom fields. Reproduces issue #487.
#
#   yarn workspace @plunk/db bench:contact-fields
#
# Not wired into `yarn test` or CI -- it seeds millions of rows and takes tens of
# minutes. Run it by hand when touching the field-discovery query or its cache.
#
# Environment:
#   BENCH_CONTACTS   rows in the measured tenant (default 2000000)
#   BENCH_PORT       host port for the throwaway postgres (default 55434)
#   BENCH_CONTAINER  container name (default plunk-bench-contact-fields)
#   BENCH_KEEP       set to 1 to leave the container up for manual EXPLAIN work
#   BENCH_RUNS       timed repetitions per query, median reported (default 3)
#   BENCH_SAMPLES    sample sizes to evaluate (default "10000 50000 200000")
#   BENCH_SKIP_LEGACY set to 1 to skip the slow baseline when iterating on candidates
#
set -euo pipefail

CONTACTS="${BENCH_CONTACTS:-2000000}"
PORT="${BENCH_PORT:-55434}"
CONTAINER="${BENCH_CONTAINER:-plunk-bench-contact-fields}"
RUNS="${BENCH_RUNS:-3}"
read -r -a SAMPLES <<<"${BENCH_SAMPLES:-10000 50000 200000}"
PROJECT="bench_main"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PKG="$(cd "$HERE/../.." && pwd)"

cleanup() {
  if [[ "${BENCH_KEEP:-0}" == "1" ]]; then
    echo ""
    echo "BENCH_KEEP=1 -- container '$CONTAINER' left running on port $PORT"
    echo "  psql postgresql://postgres:bench@localhost:$PORT/bench"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

psqlq() { docker exec -i "$CONTAINER" psql -U postgres -d bench -v ON_ERROR_STOP=1 -qAt "$@"; }

median() { sort -n | awk '{a[NR]=$1} END {print (NR%2) ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2}'; }

# Median EXPLAIN ANALYZE execution time in ms. Uses the server-reported figure so client
# and network overhead stay out of the comparison.
timed() {
  local sql="$1" i
  psqlq -c "EXPLAIN (ANALYZE) $sql" >/dev/null 2>&1   # warm the cache
  for ((i = 0; i < RUNS; i++)); do
    psqlq -c "EXPLAIN (ANALYZE) $sql" | awk '/Execution Time/ {print $3}'
  done | median
}

# --- query shapes -------------------------------------------------------------

# The exact count(*) getAvailableFields() runs before the field query, to use as the
# coverage denominator. Timed on its own because both the old and the new exact shape
# need it, and because it is the part a sampled shape gets to skip entirely.
count_sql() {
  echo "SELECT count(*) FROM contacts WHERE \"projectId\" = '$PROJECT';"
}

# BEFORE: ContactService.getAvailableFields() as it stands on `next`, verbatim.
#
# Three CTEs, each doing its own pass over the tenant. field_counts is the expensive
# one: it joins the discovered keys back against the whole contact set, so the table is
# re-read once per field.
legacy_sql() {
  cat <<SQL
WITH field_keys AS (
  SELECT DISTINCT jsonb_object_keys(data) as key
  FROM contacts
  WHERE
    "projectId" = '$PROJECT'
    AND data IS NOT NULL
    AND jsonb_typeof(data) = 'object'
),
field_samples AS (
  SELECT
    fk.key,
    jsonb_typeof(c.data->fk.key) as json_type,
    (c.data->>fk.key) as sample_value
  FROM field_keys fk
  CROSS JOIN LATERAL (
    SELECT data
    FROM contacts
    WHERE
      "projectId" = '$PROJECT'
      AND data ? fk.key
      AND data->fk.key IS NOT NULL
    LIMIT 1
  ) c
),
field_counts AS (
  SELECT
    fk.key,
    COUNT(*) as contact_count
  FROM field_keys fk
  JOIN contacts c ON c."projectId" = '$PROJECT'
    AND c.data ? fk.key
    AND c.data->fk.key IS NOT NULL
  GROUP BY fk.key
)
SELECT
  fs.key,
  fs.sample_value,
  fs.json_type,
  fc.contact_count
FROM field_samples fs
JOIN field_counts fc ON fc.key = fs.key
SQL
}

# AFTER candidate: one pass over the tenant, expanding each contact's jsonb once with
# jsonb_each and deriving the key, its coverage, its type and a sample value from that
# single expansion.
#
# Type is reported as a min/max pair rather than a mode(): mode() is an ordered-set
# aggregate and would sort every expanded pair, which at 60M pairs costs more than the
# scan it rides on. min = max means the field is type-homogeneous, which is the case
# that matters; the caller treats a mismatch as 'string'.
#
# The null filter is a FILTER rather than a WHERE so a key whose values are all JSON
# null is still *discovered* (it stays in the dropdown) while its coverage correctly
# reads 0 rather than 100%.
onepass_exact_sql() {
  cat <<SQL
SELECT
  kv.key AS key,
  count(*) FILTER (WHERE kv.value <> 'null'::jsonb) AS contact_count,
  min(jsonb_typeof(kv.value)) FILTER (WHERE kv.value <> 'null'::jsonb) AS type_min,
  max(jsonb_typeof(kv.value)) FILTER (WHERE kv.value <> 'null'::jsonb) AS type_max,
  min((kv.value #>> '{}') COLLATE "C") FILTER (WHERE kv.value <> 'null'::jsonb) AS sample_value
FROM contacts c
CROSS JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(c.data) = 'object' THEN c.data ELSE '{}'::jsonb END
) kv
WHERE c."projectId" = '$PROJECT'
GROUP BY kv.key
SQL
}

# AFTER candidate: the same single pass, but stopped after \$1 contacts. Coverage becomes
# a ratio within the sample, which removes the need for the count(*) entirely -- the
# denominator falls out of the same scan.
#
# `LIMIT n` with no ORDER BY returns whatever the scan reaches first. That is the point
# of measuring it: the accuracy table below reports what that bias costs.
onepass_sample_sql() {
  cat <<SQL
WITH sample AS MATERIALIZED (
  SELECT data FROM contacts WHERE "projectId" = '$PROJECT' LIMIT $1
)
SELECT
  kv.key AS key,
  count(*) FILTER (WHERE kv.value <> 'null'::jsonb) AS contact_count,
  min(jsonb_typeof(kv.value)) FILTER (WHERE kv.value <> 'null'::jsonb) AS type_min,
  max(jsonb_typeof(kv.value)) FILTER (WHERE kv.value <> 'null'::jsonb) AS type_max,
  min((kv.value #>> '{}') COLLATE "C") FILTER (WHERE kv.value <> 'null'::jsonb) AS sample_value,
  (SELECT count(*) FROM sample) AS denominator
FROM sample s
CROSS JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(s.data) = 'object' THEN s.data ELSE '{}'::jsonb END
) kv
GROUP BY kv.key
SQL
}

# --- result materialization ---------------------------------------------------
# Same SQL that was timed, stored so the accuracy comparison measures the shape that
# was actually benchmarked rather than a re-derivation of it.

materialize() { # $1 = table, $2 = sql, $3 = denominator expression
  psqlq -c "SET client_min_messages = warning;
            DROP TABLE IF EXISTS $1;
            CREATE TABLE $1 AS
            SELECT q.*, round(100.0 * q.contact_count / ($3)) AS coverage
            FROM ($2) q;" >/dev/null
}

# --- run ----------------------------------------------------------------------

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

echo "==> starting postgres ($CONTAINER, port $PORT)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench -e LANG=en_US.utf8 \
  -p "$PORT:5432" --shm-size=1g postgres:16 \
  -c shared_buffers=2GB -c work_mem=64MB -c maintenance_work_mem=1GB \
  -c effective_cache_size=6GB -c random_page_cost=1.1 >/dev/null

for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "==> applying migrations"
DATABASE_URL="postgresql://postgres:bench@localhost:$PORT/bench" \
DIRECT_DATABASE_URL="postgresql://postgres:bench@localhost:$PORT/bench" \
  yarn --cwd "$DB_PKG" prisma migrate deploy >/dev/null

echo "==> seeding ~$CONTACTS contacts x ~32 custom fields (minutes, not seconds)"
docker exec -i "$CONTAINER" psql -U postgres -d bench -q \
  -v contacts="$CONTACTS" -v project="$PROJECT" -f - < "$HERE/seed.sql" >/dev/null

TOTAL=$(psqlq -c "$(count_sql)")
KEYS=$(psqlq -c "SELECT count(DISTINCT k) FROM contacts, LATERAL jsonb_object_keys(data) k WHERE \"projectId\" = '$PROJECT';")
SIZE=$(psqlq -c "SELECT pg_size_pretty(pg_total_relation_size('contacts'));")
echo "    $TOTAL contacts in '$PROJECT', $KEYS distinct custom fields, contacts table $SIZE"

echo "==> measuring count(*) (the coverage denominator)"
T_COUNT=$(timed "$(count_sql)")

if [[ "${BENCH_SKIP_LEGACY:-0}" != "1" ]]; then
  echo "==> measuring BEFORE: 3-CTE query as on \`next\` (slow -- minutes per repetition)"
  T_LEGACY=$(timed "$(legacy_sql)")
  materialize bench_legacy "$(legacy_sql)" "$TOTAL"
else
  T_LEGACY="skipped"
fi

echo "==> measuring AFTER: single-pass exact"
T_EXACT=$(timed "$(onepass_exact_sql)")
materialize bench_exact "$(onepass_exact_sql)" "$TOTAL"

declare -A T_SAMPLE
for n in "${SAMPLES[@]}"; do
  echo "==> measuring AFTER: single-pass sampled at $n"
  T_SAMPLE[$n]=$(timed "$(onepass_sample_sql "$n")")
  materialize "bench_s$n" "$(onepass_sample_sql "$n")" "q.denominator"
done

# --- report -------------------------------------------------------------------
echo ""
echo "contacts in tenant: $TOTAL   distinct custom fields: $KEYS   runs per query: $RUNS"
echo "median EXPLAIN ANALYZE execution time, ms"
echo ""
printf '  %-46s %12s\n' 'query' 'ms'
printf '  %s\n' '-----------------------------------------------------------'
printf '  %-46s %12s\n' 'count(*) -- coverage denominator' "$T_COUNT"
printf '  %-46s %12s\n' 'before: 3-CTE field discovery' "$T_LEGACY"
printf '  %-46s %12s\n' 'after: single-pass exact' "$T_EXACT"
for n in "${SAMPLES[@]}"; do
  printf '  %-46s %12s\n' "after: single-pass sampled at $n" "${T_SAMPLE[$n]}"
done
printf '  %s\n' '-----------------------------------------------------------'
echo ""
echo "  The endpoint runs count(*) + field discovery, so the before total is"
echo "  count + 3-CTE. A sampled shape needs no count(*) at all: its denominator"
echo "  is the sample size, which the same scan already produced."

echo ""
echo "accuracy of each sampled shape against the exact single pass:"
echo ""
printf '  %-12s %8s %10s %14s %14s\n' 'sample' 'keys' 'missed' 'max cov err' 'type mismatch'
printf '  %s\n' '-----------------------------------------------------------------'
EXACT_KEYS=$(psqlq -c "SELECT count(*) FROM bench_exact;")
printf '  %-12s %8s %10s %14s %14s\n' 'exact' "$EXACT_KEYS" '-' '-' '-'
for n in "${SAMPLES[@]}"; do
  acc=$(psqlq -F' ' -c "
    SELECT
      (SELECT count(*) FROM bench_s$n),
      (SELECT count(*) FROM bench_exact e WHERE NOT EXISTS (SELECT 1 FROM bench_s$n s WHERE s.key = e.key)),
      (SELECT coalesce(max(abs(e.coverage - s.coverage)), 0) FROM bench_exact e JOIN bench_s$n s ON s.key = e.key),
      (SELECT count(*) FROM bench_exact e JOIN bench_s$n s ON s.key = e.key
        WHERE e.type_min IS DISTINCT FROM s.type_min);")
  read -r k missed err mismatch <<<"$acc"
  printf '  %-12s %8s %10s %14s %14s\n' "$n" "$k" "$missed" "$err" "$mismatch"
done
printf '  %s\n' '-----------------------------------------------------------------'

for n in "${SAMPLES[@]}"; do
  MISSING=$(psqlq -c "SELECT string_agg(e.key, ', ' ORDER BY e.key) FROM bench_exact e
                      WHERE NOT EXISTS (SELECT 1 FROM bench_s$n s WHERE s.key = e.key);")
  [[ -n "$MISSING" ]] && echo "  sampled at $n misses: $MISSING"
done

if [[ "${BENCH_SKIP_LEGACY:-0}" != "1" ]]; then
  echo ""
  echo "coverage semantics, old vs new (keys where the two disagree):"
  psqlq -F' ' -c "
    SELECT l.key || ': ' || l.coverage || '% -> ' || e.coverage || '%'
    FROM bench_legacy l JOIN bench_exact e ON e.key = l.key
    WHERE l.coverage IS DISTINCT FROM e.coverage
    ORDER BY l.key;" | sed 's/^/  /'
  echo "  (the old query counts a stored JSON null as covered; the new one does not)"
fi
