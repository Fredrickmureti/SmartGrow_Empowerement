CREATE OR REPLACE FUNCTION public.default_journal_book_for_source(_business_id uuid, _source_type text, _bank_account_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH target AS (
    SELECT CASE
      WHEN public.normalize_journal_source_type(_source_type) IN ('mf_loan_event','mf_collection_banking') THEN 'lending'
      WHEN public.normalize_journal_source_type(_source_type) = 'invoice' THEN 'sale'
      WHEN public.normalize_journal_source_type(_source_type) = 'bill' THEN 'purchase'
      WHEN public.normalize_journal_source_type(_source_type) IN ('payment','bill_payment','bank_reconciliation','bank_statement') THEN 'bank'
      ELSE 'general'
    END AS jt
  ), picked AS (
    SELECT jb.id, jb.is_system, jb.code
    FROM public.journal_books jb, target t
    WHERE jb.business_id = _business_id
      AND jb.is_active
      AND jb.journal_type = t.jt
    ORDER BY jb.is_system DESC, jb.code
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT id FROM picked),
    (SELECT jb.id FROM public.journal_books jb
      WHERE jb.business_id = _business_id AND jb.is_active AND jb.journal_type = 'general'
      ORDER BY jb.is_system DESC, jb.code LIMIT 1)
  );
$function$;
-- Rollback: restore the previous body without the lending branch and COALESCE fallback.