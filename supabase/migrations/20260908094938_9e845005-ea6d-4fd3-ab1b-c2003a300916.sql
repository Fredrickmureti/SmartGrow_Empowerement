CREATE OR REPLACE FUNCTION public.seed_default_journal_books(_business_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org_id UUID;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  INSERT INTO public.journal_books (organization_id, business_id, code, name, journal_type, is_system, description)
  VALUES
    (_org_id, _business_id, 'LND',  'Lending Journal',   'lending',  true, 'Loan disbursements, repayments, write-offs and collection banking'),
    (_org_id, _business_id, 'BNK',  'Bank Journal',      'bank',     true, 'Bank deposits, withdrawals, and transfers'),
    (_org_id, _business_id, 'CSH',  'Cash Journal',      'cash',     true, 'Cash receipts and disbursements'),
    (_org_id, _business_id, 'MISC', 'Miscellaneous',     'general',  true, 'Manual journal entries and adjustments')
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$function$;
-- Rollback: restore the previous body (SAL/PUR seeded, no LND).