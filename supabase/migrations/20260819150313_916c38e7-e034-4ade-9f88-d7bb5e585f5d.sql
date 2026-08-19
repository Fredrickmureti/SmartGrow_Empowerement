-- 1. A bank line records the resolution that explained it. The seam can
--    resolve a line as an existing receipt (payment), an existing supplier
--    payment (bill_payment) or a plain classification (account); the old
--    constraint predated those kinds, so bank_match_confirm aborted after
--    posting and the line stayed unreconciled.
ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_reconciled_type_check;

ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_reconciled_type_check
  CHECK (reconciled_type = ANY (ARRAY[
    'invoice'::text, 'bill'::text, 'expense'::text, 'transfer'::text,
    'manual'::text, 'payment'::text, 'bill_payment'::text, 'account'::text
  ]));

-- 2. An open proposal is the status vocabulary the seam actually writes:
--    bank_match_propose inserts 'suggested' (and 'to_check' is its sibling);
--    'proposed' is not even permitted by the matches status constraint, so
--    both guards below were blind to open proposals.
CREATE OR REPLACE FUNCTION public._bank_doc_is_spoken_for(_kind text, _doc_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
     WHERE m.status IN ('suggested', 'to_check', 'confirmed')
       AND m.allocations @> jsonb_build_array(
             jsonb_build_object('document_type', _kind, 'document_id', _doc_id::text))
  );
$function$;

-- 3. Same alignment inside bank_match_candidates' "already explained" guard.
--    Patched textually so the rest of the 300-line evidence engine is provably
--    byte-identical; the replacements are asserted rather than assumed.
DO $mig$
DECLARE
  _def text;
  _new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_candidates';

  IF _def IS NULL THEN
    RAISE EXCEPTION 'bank_match_candidates not found';
  END IF;
  IF position('m.status IN (''confirmed'', ''proposed'')' IN _def) = 0 THEN
    RAISE EXCEPTION 'bank_match_candidates open-proposal predicate not found — refusing to patch blindly';
  END IF;
  IF position('_open.status = ''proposed''' IN _def) = 0 THEN
    RAISE EXCEPTION 'bank_match_candidates tier predicate not found — refusing to patch blindly';
  END IF;

  _new := replace(_def,
    'm.status IN (''confirmed'', ''proposed'')',
    'm.status IN (''confirmed'', ''suggested'', ''to_check'')');
  _new := replace(_new,
    '_open.status = ''proposed''',
    '_open.status <> ''confirmed''');

  EXECUTE _new;
END
$mig$;