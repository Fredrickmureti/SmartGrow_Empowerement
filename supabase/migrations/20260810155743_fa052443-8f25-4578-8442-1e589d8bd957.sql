DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_bill_atomic';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'confirm_bill_atomic not found';
  END IF;

  v_old := $old$  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft bills can be confirmed (current: %)', v_bill.status;
  END IF;$old$;

  v_new := $new$  IF v_bill.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'Only draft or approved bills can be confirmed (current: %)', v_bill.status;
  END IF;$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'confirm_bill_atomic status guard does not match expected source; refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $do$;