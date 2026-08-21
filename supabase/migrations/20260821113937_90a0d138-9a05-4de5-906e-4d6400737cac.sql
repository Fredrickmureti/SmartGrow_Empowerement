-- FX Foundation Step 2.2 — credit note families declare their denomination.
DO $$
DECLARE
  v_def text; v_new text;
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('issue_credit_note_atomic',        '_currency := v_cn.currency,'  || chr(10) || '    _exchange_rate := NULL,',
                                          '_currency := v_cn.currency,'  || chr(10) || '    _exchange_rate := v_cn.exchange_rate,' || chr(10) || '    _amounts_in_document_currency := true,'),
      ('issue_vendor_credit_note_atomic', '_currency := v_vcn.currency,' || chr(10) || '    _exchange_rate := NULL,',
                                          '_currency := v_vcn.currency,' || chr(10) || '    _exchange_rate := v_vcn.exchange_rate,' || chr(10) || '    _amounts_in_document_currency := true,')
    ) AS t(fname, old_txt, new_txt)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname = r.fname;

    IF v_def IS NULL THEN
      RAISE EXCEPTION '% is missing', r.fname;
    END IF;

    v_new := replace(v_def, r.old_txt, r.new_txt);
    IF v_new = v_def THEN
      RAISE EXCEPTION '% posting call did not match the expected shape; not patched', r.fname;
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;