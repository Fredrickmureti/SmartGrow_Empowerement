-- Every business_event_outbox producer must publish a source value that the
-- event_source_domain check constraint actually accepts.
--
-- Why this test exists: the AP producers (_emit_bill_lifecycle_outbox and
-- _emit_bill_payment_outbox) shipped with source = 'ap', which is NOT a member
-- of the domain. The constraint rejected the insert inside an AFTER trigger, so
-- every bill status transition and every bill payment aborted outright — the
-- payables module was fully unusable and no catalog-level check caught it.
DO $$
DECLARE
  v_allowed text[] := ARRAY[
    'pos','finance','accounting','cash_management','statement','manual','system',
    'trigger','procurement','purchasing','sales','crm','hr','payroll','inventory',
    'warehouse'
  ];
  v_bad text := '';
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, m[1] AS src_literal
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace,
           regexp_matches(pg_get_functiondef(p.oid), $$auth.uid\(\),\s*'([a-z_]+)'$$, 'g') m
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) LIKE '%business_event_outbox%'
  LOOP
    -- Skip role literals (e.g. 'admin', 'owner') that appear in permission
    -- checks rather than as the outbox source column.
    IF r.src_literal IN ('admin','owner','manager','member') THEN CONTINUE; END IF;
    IF NOT (r.src_literal = ANY (v_allowed)) THEN
      v_bad := v_bad || format(' %s -> %L;', r.proname, r.src_literal);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'business_event_outbox producers publish invalid source domains:%', v_bad;
  END IF;
END $$;

-- A producer must also only read columns that exist on the row it fires against.
-- _emit_bill_payment_outbox read NEW.currency; bill_payments only has
-- currency_rate, so the trigger raised "record new has no field currency".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_emit_bill_payment_outbox'
       AND pg_get_functiondef(p.oid) ~ 'NEW\.currency[^_]'
  ) THEN
    RAISE EXCEPTION '_emit_bill_payment_outbox reads NEW.currency, a column bill_payments does not have';
  END IF;
END $$;
