# Contact fields benchmark

Measures `GET /contacts/fields` — `ContactService.getAvailableFields()` — against a
synthetic corpus of millions of contacts carrying ~30 custom fields. Reproduces
[#487](https://github.com/useplunk/plunk/issues/487), where the segment builder sat on
"Loading available fields and events..." for close to a minute.

```bash
yarn workspace @plunk/db bench:contact-fields
```

Requires Docker. It starts a throwaway Postgres on port 55434, applies the real Prisma
migrations, seeds ~2M contacts, measures, and tears the container down. Takes tens of
minutes and is deliberately **not** wired into `yarn test` or CI — run it by hand when
touching field discovery or its cache.

| Variable | Default | |
|---|---|---|
| `BENCH_CONTACTS` | `2000000` | rows in the measured tenant |
| `BENCH_PORT` | `55434` | host port for the throwaway Postgres |
| `BENCH_CONTAINER` | `plunk-bench-contact-fields` | container name |
| `BENCH_RUNS` | `3` | timed repetitions per query; the median is reported |
| `BENCH_SAMPLES` | `10000 50000 200000` | sample sizes to evaluate |
| `BENCH_SKIP_LEGACY` | unset | set to `1` to skip the slow baseline |
| `BENCH_KEEP` | unset | set to `1` to leave the container up for manual `EXPLAIN` |

A quick sanity run:
`BENCH_CONTACTS=40000 BENCH_RUNS=2 yarn workspace @plunk/db bench:contact-fields`.

## What it measures

The endpoint does two things: an exact `count(*)` for the coverage denominator, and the
field discovery itself. Both are timed, because only one of them turned out to matter.

- **before** — the three-CTE query as it stood on `next`, copied verbatim
- **after: single-pass exact** — one pass, expanding each contact's `data` once with
  `jsonb_each`
- **after: single-pass sampled at N** — the same pass stopped after N contacts

Sampled shapes are also checked for *accuracy* against the exact pass: how many fields
they fail to discover, how far their coverage percentages drift, and whether they infer
a different type.

### Keeping it honest

The candidate query is written out in `run.sh` rather than imported, so it can drift from
the one that actually ships. The contact-search benchmark avoids this by replaying its
migration file verbatim; there is no equivalent here, because this query lives inline in
a Prisma `$queryRaw`. Instead the run compares the two texts and prints

```
single-pass exact matches ContactService.getAvailableFields
```

before measuring, and warns loudly if they have diverged. A benchmark quietly measuring a
query nobody runs is worse than no benchmark, because the numbers still look
authoritative.

## Results at 2M contacts

Postgres 16, `en_US.utf8`, `shared_buffers=2GB`, warm cache, median of 3.
2,000,000 contacts, 32 distinct custom fields, `contacts` table 2179 MB.
Median `EXPLAIN ANALYZE` execution time in ms.

| query | ms |
|---|---|
| `count(*)` — the coverage denominator | 50.8 |
| **before**: 3-CTE field discovery | **38,034** |
| **after**: single-pass exact | **9,452** |
| after: single-pass sampled at 10,000 | 154 |
| after: single-pass sampled at 50,000 | 757 |
| after: single-pass sampled at 200,000 | 2,799 |

Accuracy of each sampled shape against the exact pass:

| sample | keys found | missed | max coverage error | type mismatch |
|---|---|---|---|---|
| exact | 32 | — | — | — |
| 10,000 | 31 | 1 | 95 points | 0 |
| 50,000 | 31 | 1 | 95 points | 0 |
| 200,000 | 31 | 1 | 45 points | 0 |

All three miss the same field: `recentlyAdded`.

### The cached path

The numbers above are all cache *misses*. What the dashboard actually hits, measured
separately against a 36-field payload (2,114 bytes — the same shape this corpus
produces), 1000 samples after warm-up:

| | ms |
|---|---|
| p50 | 0.063 |
| p95 | 0.143 |
| p99 | 0.215 |
| max | 3.977 |

That is a Redis `GET` plus a `JSON.parse`, so it scales with the number of fields, not
the number of contacts — a 2M-contact tenant and a 200-contact tenant pay the same.
Measured at the service method, so it excludes HTTP, auth middleware and serialization,
and Redis was on loopback; a managed Redis adds its round trip.

## Reading the results

**The count was never the problem.** 51 ms against 38 s. It is also now issued alongside
the scan rather than before it, so it costs nothing at all in wall-clock terms.

**The old shape scaled with contacts × fields, not contacts.** It discovered the keys,
then joined them back against the whole contact set to count them, and probed the set
again for a sample value. The table was re-read once per field and every row's `jsonb`
was parsed once per field. Thirty fields meant thirty passes. The single pass expands
each contact exactly once and derives every key's coverage, type and sample value from
that one expansion — 4x here, and the gap widens with each field a tenant adds, because
the old cost grew with the field count and the new one does not.

**Sampling is fast and wrong, which is why it did not ship.** At 10k contacts it is 250x
faster than the exact pass and 60x faster still than what it replaces. It also never
finds `recentlyAdded`, and misreports coverage by up to 95 percentage points.

`LIMIT n` without an `ORDER BY` returns whatever the scan reaches first, which is roughly
insertion order, so the sample is drawn from the *oldest* contacts in the project. The
corpus plants two fields by insertion position specifically to catch this:
`legacyCrmId` on the first 5% of rows and `recentlyAdded` on the last 5%. A front-of-table
sample sees `legacyCrmId` on nearly every row it looks at and reports ~100% coverage for
a field that 5% of contacts have; it never reaches a single contact carrying
`recentlyAdded` and drops the field entirely.

Translated out of the benchmark: *a custom field you started writing last month would not
appear in the segment builder at all*, and the cache would then hold that wrong answer
for hours. Sampling from the other end of the table just inverts which field disappears.
A genuinely unbiased sample needs `ORDER BY random()` (a full scan, so no saving) or
`TABLESAMPLE` (which applies before the `projectId` filter, so it collapses for any
tenant that is not most of the table). None of that is worth a field silently vanishing
from the UI, so the exact pass ships.

**What actually fixes the reported symptom is the cache, not the query.** 9.5 s is still
far too slow to sit in front of a dialog opening. The query work matters because it sets
the price of a cache miss and of the refresh button — 9.5 s is a spinner, 38 s is a
support ticket — but the reason the builder now opens instantly is that it is not running
this at all. See `ContactService.getAvailableFields`.

**What is left is the scan itself.** 2179 MB read and ~64M key/value pairs aggregated;
there is no index that can enumerate the distinct keys of a `jsonb` column, so this is a
heap scan however it is written. Getting meaningfully below this means not scanning on
read at all — maintaining a field list incrementally as contacts are written — which is a
much larger change than #487 called for.

## A coverage semantics change

The benchmark reports this separately, because it is a behaviour change rather than a
speedup:

```
nullableField: 100% -> 30%
```

The old query tested `data->key IS NOT NULL`. A *stored JSON null* (`{"plan": null}`)
yields a `jsonb` null, not SQL `NULL`, so it passed that test — a field explicitly set to
null on every contact reported 100% coverage. The replacement excludes stored nulls from
the count, so that field now reports what it actually covers. The key is still
*discovered* either way, so nothing disappears from the pickers.

## Caveats

- Warm cache throughout. Production with a cold cache is slower across the board, which
  makes the relative wins larger, not smaller.
- The corpus is uniform: every contact carries the same ~32 keys at fixed probabilities.
  Real tenants have messier distributions — a handful of keys from an abandoned import,
  say — and the field *count* is what the old shape scaled on, so a tenant with 100 stray
  keys was hurt considerably worse than this measures.
- `recentlyAdded` and `legacyCrmId` are planted to expose sampling bias and are not
  meant to be realistic. The other 30 fields are randomly distributed.
- No concurrent write load during measurement.
- The single-pass figure is one query on one connection. The endpoint also runs the
  `count(*)` concurrently, so its wall time is the larger of the two, not the sum.
