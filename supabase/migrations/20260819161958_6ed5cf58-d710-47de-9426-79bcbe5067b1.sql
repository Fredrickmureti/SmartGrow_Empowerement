-- 1. Allow hyphenated prefixes (OB-BANK) in the shared numbering authority.
CREATE OR REPLACE FUNCTION public.get_next_document_number(p_org uuid, p_business uuid, p_prefix text, p_table text, p_column text, p_business_column text DEFAULT 'business_id'::text, p_width integer DEFAULT 4)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year   text := to_char(now(), 'YYYY');
  v_next   int;
  v_num    text;
  v_taken  boolean;
  v_guard  int := 0;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'get_next_document_number: organization is required';
  END IF;
  -- Uppercase letter runs, optionally joined by single hyphens (OB-BANK).
  IF p_prefix IS NULL OR p_prefix !~ '^[A-Z]+(-[A-Z]+)*$' THEN
    RAISE EXCEPTION 'get_next_document_number: prefix must be uppercase letters, got %', p_prefix;
  END IF;

  -- Serialise issuance per prefix + organization (+ business where the
  -- uniqueness constraint is narrower) for the whole transaction.
  PERFORM pg_advisory_xact_lock(
    hashtext('document_number:' || p_prefix || ':' || p_org::text
             || ':' || COALESCE(p_business::text, '-')));

  -- Parse ONLY the trailing counter segment. Stripping every non-digit from
  -- the whole string folds the year into the counter (PO-2026-20260004).
  EXECUTE format(
    'SELECT COALESCE(MAX((regexp_match(%1$I, %2$L))[1]::int), 0) + 1
       FROM public.%3$I
      WHERE organization_id = $1
        AND ($2 IS NULL OR %4$I = $2)
        AND %1$I ~ %5$L',
    p_column,
    '([0-9]+)$',
    p_table,
    p_business_column,
    '^' || p_prefix || '-' || v_year || '-[0-9]+$'
  )
  INTO v_next
  USING p_org, p_business;

  -- Collision guard: a stale max must never surface as a unique violation.
  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 1000 THEN
      RAISE EXCEPTION 'get_next_document_number: could not allocate a % number', p_prefix;
    END IF;

    v_num := p_prefix || '-' || v_year || '-' || LPAD(v_next::text, GREATEST(p_width, 1), '0');

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%1$I
                       WHERE organization_id = $1
                         AND ($2 IS NULL OR %2$I = $2)
                         AND %3$I = $3)',
      p_table, p_business_column, p_column
    )
    INTO v_taken
    USING p_org, p_business, v_num;

    EXIT WHEN NOT v_taken;
    v_next := v_next + 1;
  END LOOP;

  RETURN v_num;
END;
$function$;

-- 2..6 Replace UUID-slice GL references with real, sequential ones. Each
-- function is patched textually so none of its unrelated logic can drift.
DO $mig$
DECLARE
  d text;
BEGIN
  -- bank deposit clearing (bank reconciliation)
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_confirm';
  IF d IS NULL OR position('''BDEP-'' || substr(_match_id::text, 1, 8)' IN d) = 0 THEN
    RAISE EXCEPTION 'bank_match_confirm: BDEP reference marker not found';
  END IF;
  d := replace(d,
    '''BDEP-'' || substr(_match_id::text, 1, 8)',
    'public.get_next_document_number(_txn.organization_id, _txn.business_id, ''BDEP'', ''journal_entries'', ''reference'', ''business_id'', 4)');
  EXECUTE d;

  -- bank opening balance
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_bank_account_post_opening_balance';
  IF d IS NULL OR position('''OB-BANK-'' || LEFT(a.id::text, 8)' IN d) = 0 THEN
    RAISE EXCEPTION '_bank_account_post_opening_balance: OB-BANK reference marker not found';
  END IF;
  d := replace(d,
    '''OB-BANK-'' || LEFT(a.id::text, 8)',
    'public.get_next_document_number(a.organization_id, a.business_id, ''OB-BANK'', ''journal_entries'', ''reference'', ''business_id'', 4)');
  EXECUTE d;

  -- employee advance disbursement
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'disburse_employee_advance';
  IF d IS NULL OR position('''ADV-'' || left(p_advance_id::text, 8)' IN d) = 0 THEN
    RAISE EXCEPTION 'disburse_employee_advance: ADV reference marker not found';
  END IF;
  d := replace(d,
    '''ADV-'' || left(p_advance_id::text, 8)',
    'public.get_next_document_number(v_adv.organization_id, v_adv.business_id, ''ADV'', ''journal_entries'', ''reference'', ''business_id'', 4)');
  EXECUTE d;

  -- supplier advance payment
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_vendor_advance_payment';
  IF d IS NULL OR position('''VADV-'' || substr(v_payment_id::text, 1, 8)' IN d) = 0 THEN
    RAISE EXCEPTION 'record_vendor_advance_payment: VADV reference marker not found';
  END IF;
  d := replace(d,
    '''VADV-'' || substr(v_payment_id::text, 1, 8)',
    'public.get_next_document_number(_org_id, _business_id, ''VADV'', ''journal_entries'', ''reference'', ''business_id'', 4)');
  EXECUTE d;

  -- expense approval request label: quote the expense's own number
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'expense_submit';
  IF d IS NULL OR position('COALESCE(r.reference, ''EXP-'' || left(p_expense_id::text, 8))' IN d) = 0 THEN
    RAISE EXCEPTION 'expense_submit: EXP reference marker not found';
  END IF;
  d := replace(d,
    'COALESCE(r.reference, ''EXP-'' || left(p_expense_id::text, 8))',
    'COALESCE(NULLIF(r.reference, ''''), r.expense_number)');
  EXECUTE d;
END
$mig$;