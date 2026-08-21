-- FX Foundation Step 2.1 — AP bills declare their denomination.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='confirm_bill_atomic';

  v_new := replace(v_def,
$old$    v_lines,
    NULL, NULL, NULL, v_bill.branch_id
  );$old$,
$new$    v_lines,
    v_bill.currency, v_bill.currency_rate, NULL, v_bill.branch_id,
    false, true
  );$new$);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'confirm_bill_atomic posting call did not match the expected shape; not patched';
  END IF;

  EXECUTE v_new;
END $$;