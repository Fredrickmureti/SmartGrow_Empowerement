-- payroll_gl_tag_split_test.sql
-- Pins the Phase C invariants that let post-payroll-gl split salary_expense
-- by accounting_tag without ever dropping or double-counting a shilling:
--   (1) payslip_lines.accounting_tag column exists and is nullable.
--   (2) The partial index payslip_lines_run_tag_idx exists and is scoped
--       to accounting_tag IS NOT NULL (the exact predicate the aggregation
--       query relies on; a full index would drag every NULL row through it).
--   (3) Aggregation contract (mirrors the SQL post-payroll-gl runs):
--         SUM(employee_amount) GROUP BY accounting_tag
--         over earning categories only, employer-cost rows are excluded.
--       - Per-tag totals match seeded amounts.
--       - Untagged bucket sums to exactly the NULL-tag rows.
--       - Grand total across every bucket = sum of every earning row
--         (no drop, no double count).
--   (4) All-NULL-tag baseline invariant: when no line carries a tag,
--       the aggregation collapses to a single (NULL) bucket whose total
--       equals gross earnings — this is the "byte-identical to pre-Phase-C"
--       promise the migration made.
BEGIN;

  -- (1) Column shape.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'payslip_lines'
         AND column_name  = 'accounting_tag'
         AND data_type    = 'text'
         AND is_nullable  = 'YES'
    ) THEN
      RAISE EXCEPTION 'payslip_lines.accounting_tag missing or not nullable text';
    END IF;
  END $$;

  -- (2) Partial index shape.
  DO $$
  DECLARE v_def text;
  BEGIN
    SELECT indexdef INTO v_def
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname  = 'payslip_lines_run_tag_idx';
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'payslip_lines_run_tag_idx missing — GL aggregation degrades to a seq scan per run';
    END IF;
    IF position('accounting_tag IS NOT NULL' IN v_def) = 0 THEN
      RAISE EXCEPTION 'payslip_lines_run_tag_idx exists but is not partial on accounting_tag IS NOT NULL; got: %', v_def;
    END IF;
    IF position('payroll_run_id' IN v_def) = 0
       OR position('accounting_tag' IN v_def) = 0 THEN
      RAISE EXCEPTION 'payslip_lines_run_tag_idx must key (payroll_run_id, accounting_tag); got: %', v_def;
    END IF;
  END $$;

  -- (3) & (4) Aggregation contract — mirrors post-payroll-gl exactly.
  DO $$
  DECLARE
    v_run uuid := gen_random_uuid();
    v_tags jsonb;
    v_null_total numeric;
    v_ot_total numeric;
    v_holiday_total numeric;
    v_grand numeric;
  BEGIN
    -- Fixture as a plain values table — no FK dependencies, no tenant setup,
    -- because we're pinning the aggregation predicate, not the compute path.
    CREATE TEMP TABLE _pl_fixture (
      payroll_run_id  uuid,
      category        text,
      employee_amount numeric,
      accounting_tag  text
    ) ON COMMIT DROP;

    INSERT INTO _pl_fixture VALUES
      (v_run, 'earning',   1000, 'OT'),       -- OT bucket #1
      (v_run, 'overtime',   500, 'OT'),       -- OT bucket #2 (same tag)
      (v_run, 'earning',   2000, 'HOLIDAY'),  -- HOLIDAY bucket
      (v_run, 'allowance',  300, NULL),       -- untagged remainder
      (v_run, 'earning',    200, NULL),       -- untagged remainder
      -- Rows that MUST be ignored by the salary-expense aggregation:
      (v_run, 'employer_cost', 9999, 'OT'),   -- employer side, not gross
      (v_run, 'deduction',      50, 'OT');    -- deduction, not gross

    -- The aggregation post-payroll-gl runs (earning-side categories only).
    WITH agg AS (
      SELECT accounting_tag, SUM(employee_amount) AS total
        FROM _pl_fixture
       WHERE payroll_run_id = v_run
         AND category IN ('earning','allowance','bonus','overtime')
       GROUP BY accounting_tag
    )
    SELECT
      COALESCE(SUM(total) FILTER (WHERE accounting_tag = 'OT'),      0),
      COALESCE(SUM(total) FILTER (WHERE accounting_tag = 'HOLIDAY'), 0),
      COALESCE(SUM(total) FILTER (WHERE accounting_tag IS NULL),     0),
      COALESCE(SUM(total), 0)
      INTO v_ot_total, v_holiday_total, v_null_total, v_grand
      FROM agg;

    IF v_ot_total <> 1500 THEN
      RAISE EXCEPTION 'OT bucket should sum to 1500, got %', v_ot_total;
    END IF;
    IF v_holiday_total <> 2000 THEN
      RAISE EXCEPTION 'HOLIDAY bucket should sum to 2000, got %', v_holiday_total;
    END IF;
    IF v_null_total <> 500 THEN
      RAISE EXCEPTION 'untagged bucket should sum to 500 (only NULL-tag rows), got %', v_null_total;
    END IF;
    -- 1000+500+2000+300+200 = 4000 — employer_cost and deduction excluded.
    IF v_grand <> 4000 THEN
      RAISE EXCEPTION 'grand total across buckets should equal gross earnings (4000); got %', v_grand;
    END IF;

    -- (4) All-NULL baseline: strip every tag and re-aggregate. The result
    -- must collapse to a single NULL-tag bucket whose total equals gross —
    -- this is the pre-Phase-C JE that legacy tenants must continue to see.
    UPDATE _pl_fixture SET accounting_tag = NULL;
    WITH agg AS (
      SELECT accounting_tag, SUM(employee_amount) AS total
        FROM _pl_fixture
       WHERE payroll_run_id = v_run
         AND category IN ('earning','allowance','bonus','overtime')
       GROUP BY accounting_tag
    )
    SELECT jsonb_object_agg(COALESCE(accounting_tag, '__null__'), total)
      INTO v_tags
      FROM agg;

    IF (v_tags -> '__null__')::numeric <> 4000 THEN
      RAISE EXCEPTION 'all-NULL baseline should be a single 4000 bucket; got %', v_tags;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_tags)) <> 1 THEN
      RAISE EXCEPTION 'all-NULL baseline should produce exactly one bucket; got %', v_tags;
    END IF;
  END $$;

ROLLBACK;
