
-- Backfill payroll_runs.deductions_summary: replace any `garnishment_<uuid>`
-- key with a human label derived from legal_orders_records (kind + case_ref).
-- Idempotent, safe to re-run.
DO $$
DECLARE
  r RECORD;
  new_summary jsonb;
  k text;
  v numeric;
  gid uuid;
  human text;
  kind_val text;
  case_ref text;
BEGIN
  FOR r IN
    SELECT id, deductions_summary
    FROM public.payroll_runs
    WHERE deductions_summary::text LIKE '%garnishment_%'
  LOOP
    new_summary := '{}'::jsonb;
    FOR k, v IN
      SELECT key, (value)::numeric FROM jsonb_each_text(r.deductions_summary)
    LOOP
      IF k ~ '^garnishment_[0-9a-f-]{8,}$' THEN
        BEGIN
          gid := substring(k FROM 'garnishment_(.+)$')::uuid;
          SELECT kind::text, case_reference INTO kind_val, case_ref
          FROM public.legal_orders_records WHERE id = gid;
          IF kind_val IS NULL THEN
            human := 'Legal Order (' || left(replace(k, 'garnishment_', ''), 8) || '…)';
          ELSIF case_ref IS NOT NULL AND length(case_ref) > 0 THEN
            human := kind_val || ' (' || case_ref || ')';
          ELSE
            human := kind_val;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          human := 'Legal Order';
        END;
        new_summary := new_summary || jsonb_build_object(
          human,
          COALESCE((new_summary->>human)::numeric, 0) + v
        );
      ELSE
        new_summary := new_summary || jsonb_build_object(k, v);
      END IF;
    END LOOP;
    UPDATE public.payroll_runs SET deductions_summary = new_summary WHERE id = r.id;
  END LOOP;
END $$;
