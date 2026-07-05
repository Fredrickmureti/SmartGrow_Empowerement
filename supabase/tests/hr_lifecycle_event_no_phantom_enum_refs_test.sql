-- HR Stabilization — lifecycle-event vocabulary drift guard.
--
-- Every consumer of employee_lifecycle_events (triggers, functions, views)
-- must reference only string literals that are real members of
-- public.employee_lifecycle_event_type.
--
-- Postgres coerces IN-list / equality literals against enum columns at plan
-- time, so a single stale literal (e.g. 'returned_from_leave') breaks every
-- INSERT into employee_lifecycle_events — which in turn breaks every HR
-- write that emits a lifecycle event (contract create/activate/renew/amend/
-- expire, hire, termination, leave start/end, reinstate, onboarding,
-- salary revision, position/department/location/manager change).
--
-- This guard fails CI if any function in the `public` schema references a
-- quoted identifier that looks like a lifecycle event ('foo_bar_baz' style)
-- inside the same statement as `event_type` while that literal is NOT a
-- real member of employee_lifecycle_event_type.

BEGIN;
SELECT plan(1);

WITH enum_values AS (
  SELECT unnest(enum_range(NULL::public.employee_lifecycle_event_type))::text AS v
),
suspect_functions AS (
  SELECT
    n.nspname || '.' || p.proname AS fn,
    (regexp_matches(pg_get_functiondef(p.oid),
      $$event_type[^;]{0,400}?'([a-z][a-z0-9_]{2,})'$$, 'g'))[1] AS literal
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND pg_get_functiondef(p.oid) ~* 'employee_lifecycle_event_type|employee_lifecycle_events'
),
drift AS (
  SELECT s.fn, s.literal
  FROM suspect_functions s
  WHERE s.literal NOT IN (SELECT v FROM enum_values)
    -- Ignore common non-enum string patterns that happen to appear near event_type
    AND s.literal NOT IN (
      'hr_event','pending','partial','active','draft','computed','computing',
      'cancelled','leave_of_absence','suspension','unpaid_leave',
      'source_event_id','event_type','prior_status','new_status','payload'
    )
)
SELECT is(
  (SELECT count(*)::int FROM drift),
  0,
  'No public function may compare employee_lifecycle_events.event_type against a string literal that is not a member of employee_lifecycle_event_type. Extend the enum in the same migration if a new lifecycle concept is genuinely needed.'
);

SELECT * FROM finish();
ROLLBACK;
