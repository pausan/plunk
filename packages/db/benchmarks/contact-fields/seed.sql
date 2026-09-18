-- Synthetic contact corpus for the contact-fields benchmark.
--
-- Invoked by run.sh with `-v contacts=<n> -v project=<id>`. Reproduces the shape from
-- issue #487: millions of contacts carrying ~30 custom fields in `Contact.data`.
--
-- Field coverage is deliberately spread across four orders of magnitude (100%, 50%,
-- 10%, 1%, 0.05%). Coverage is what `getAvailableFields` spends its time computing, and
-- it is also what any sampling strategy gets wrong first: a field on 0.05% of contacts
-- is the one a small sample misses entirely. A corpus where every field sat at 100%
-- would report an accuracy that production never sees.
--
-- Two fields are placed by *insertion position* rather than at random:
--
--   legacyCrmId    -- only on the first 5% of rows inserted
--   recentlyAdded  -- only on the last 5% of rows inserted
--
-- These exist to catch sampling bias, not to be realistic. `LIMIT n` without an
-- ORDER BY returns whatever the scan reaches first, which is roughly insertion order,
-- so a sample taken from the front of the table sees `legacyCrmId` and misses
-- `recentlyAdded` -- exactly the "a field was introduced last month and does not show
-- up in the segment builder" failure. Randomly-placed fields cannot detect this,
-- because a biased sample still finds them.
--
-- `nullableField` is always present but holds a JSON null 70% of the time. Stored JSON
-- null is not SQL NULL, so the old query's `data->key IS NOT NULL` test counts those
-- contacts as covered; the replacement does not. The benchmark reports the two
-- coverage figures side by side rather than calling either one wrong.

\set ON_ERROR_STOP on

INSERT INTO projects (id, name, public, secret, "createdAt", "updatedAt")
VALUES (:'project', 'Benchmark Project', :'project' || '-public', :'project' || '-secret', now(), now())
ON CONFLICT (id) DO NOTHING;

-- A second tenant holding 20% extra rows, so `projectId` is a genuinely selective
-- predicate rather than matching the whole table.
INSERT INTO projects (id, name, public, secret, "createdAt", "updatedAt")
VALUES ('bench_other', 'Benchmark Other', 'bench_other-public', 'bench_other-secret', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO contacts (id, email, data, subscribed, "projectId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'contact' || g || '@example.com',
  jsonb_strip_nulls(jsonb_build_object(
    -- Always present (15 keys).
    'firstName',     (ARRAY['james','mary','john','robert','elena','pau'])[1 + floor(random()*6)::int],
    'lastName',      (ARRAY['smith','garcia','nguyen','pons','serra','lee'])[1 + floor(random()*6)::int],
    'plan',          (ARRAY['free','pro','enterprise'])[1 + floor(random()*3)::int],
    'country',       (ARRAY['ES','US','GB','DE','FR','NL','BR','JP'])[1 + floor(random()*8)::int],
    'platform',      (ARRAY['web','ios','android'])[1 + floor(random()*3)::int],
    'signupSource',  (ARRAY['web','api','import','referral'])[1 + floor(random()*4)::int],
    'locale',        (ARRAY['en-US','es-ES','de-DE','fr-FR'])[1 + floor(random()*4)::int],
    'timezone',      (ARRAY['Europe/Madrid','America/New_York','Asia/Tokyo'])[1 + floor(random()*3)::int],
    'tier',          (ARRAY['bronze','silver','gold'])[1 + floor(random()*3)::int],
    'language',      (ARRAY['en','es','de'])[1 + floor(random()*3)::int],
    'createdSource', (ARRAY['dashboard','api','csv'])[1 + floor(random()*3)::int],
    'marketingOptIn', random() > 0.4,
    'lifetimeValue', round((random() * 1000)::numeric, 2),
    'loginCount',    floor(random() * 500)::int,
    -- ISO 8601, so the type inference has a date to detect.
    'lastVisited',   to_char(now() - (random() * interval '365 days'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),

    -- ~50% (5 keys).
    'company',  CASE WHEN random() < 0.5 THEN 'Company ' || floor(random()*10000)::text END,
    'jobTitle', CASE WHEN random() < 0.5 THEN (ARRAY['engineer','designer','manager','founder'])[1 + floor(random()*4)::int] END,
    'phone',    CASE WHEN random() < 0.5 THEN '+34' || floor(random()*900000000 + 100000000)::text END,
    'city',     CASE WHEN random() < 0.5 THEN (ARRAY['Barcelona','Madrid','Berlin','Lisbon','Paris'])[1 + floor(random()*5)::int] END,
    'referrer', CASE WHEN random() < 0.5 THEN (ARRAY['google','twitter','hn','direct'])[1 + floor(random()*4)::int] END,

    -- ~10% (5 keys).
    'utmCampaign', CASE WHEN random() < 0.1 THEN 'campaign-' || floor(random()*50)::text END,
    'utmSource',   CASE WHEN random() < 0.1 THEN (ARRAY['newsletter','ads','partner'])[1 + floor(random()*3)::int] END,
    'utmMedium',   CASE WHEN random() < 0.1 THEN (ARRAY['email','cpc','social'])[1 + floor(random()*3)::int] END,
    'abVariant',   CASE WHEN random() < 0.1 THEN (ARRAY['a','b','control'])[1 + floor(random()*3)::int] END,
    'betaFlags',   CASE WHEN random() < 0.1 THEN (ARRAY['editor-v2','new-dash'])[1 + floor(random()*2)::int] END,

    -- ~1% (3 keys).
    'nps',         CASE WHEN random() < 0.01 THEN floor(random()*11)::int END,
    'churnRisk',   CASE WHEN random() < 0.01 THEN round(random()::numeric, 3) END,
    'supportTier', CASE WHEN random() < 0.01 THEN (ARRAY['standard','priority'])[1 + floor(random()*2)::int] END,

    -- ~0.05% (1 key). The needle a small sample loses.
    'internalNotes', CASE WHEN random() < 0.0005 THEN 'note-' || g::text END,

    -- Placed by insertion position, to expose sampling bias. See the header.
    'legacyCrmId',   CASE WHEN g <= (:contacts * 0.05) THEN 'crm-' || g::text END,
    'recentlyAdded', CASE WHEN g > (:contacts * 0.95) AND g <= :contacts THEN true END
  ))
  -- Added after jsonb_strip_nulls so the JSON null survives: the key is always present,
  -- and holds an actual JSON null 70% of the time.
  || jsonb_build_object(
       'nullableField',
       CASE WHEN random() < 0.3 THEN to_jsonb('set'::text) ELSE 'null'::jsonb END
     ),
  random() > 0.08,
  CASE WHEN g <= :contacts THEN :'project' ELSE 'bench_other' END,
  now() - (random() * interval '900 days'),
  now()
FROM generate_series(1, (:contacts * 1.2)::bigint) g
ON CONFLICT ("projectId", email) DO NOTHING;

VACUUM (ANALYZE) contacts;
