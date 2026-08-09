-- ============================================================
-- Phase 9.1 — invoice-sourced lines take their price from the invoice line
-- ============================================================
DO $do$
DECLARE
  v_def text;
  v_old text := 'COALESCE((b->>''unit_price'')::numeric, (it->>''unit_price'')::numeric)';
  v_new text := 'COALESCE((b->>''net_unit_price'')::numeric, (it->>''unit_price'')::numeric)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_sales_return_atomic';

  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'create_sales_return_atomic unit price expression not found exactly once';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$do$;

-- ============================================================
-- Phase 9.2 — the credit note is dated on the return, not on today
-- ============================================================
DO $do$
DECLARE
  v_def text;
  v_old text := 'CURRENT_DATE, ''draft'',';
  v_new text := 'COALESCE(v_return.return_date, CURRENT_DATE), ''draft'',';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_sales_return_atomic';

  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'approve_sales_return_atomic credit note date expression not found exactly once';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$do$;