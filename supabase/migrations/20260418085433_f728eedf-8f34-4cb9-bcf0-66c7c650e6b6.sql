-- Stage B: Repair historical duplicate AP journal entries
-- Void legacy trigger-created bill JEs (source_type IS NULL, paired with a real source_type='bill' JE)
UPDATE public.journal_entries je
SET status = 'voided',
    void_reason = 'Legacy duplicate trigger JE — cleaned up',
    voided_at = now(),
    updated_at = now()
WHERE je.source_type IS NULL
  AND je.status = 'posted'
  AND je.description ILIKE 'Bill %Auto-posted%'
  AND EXISTS (
    SELECT 1 FROM public.journal_entries je2
    WHERE je2.organization_id = je.organization_id
      AND je2.reference = je.reference
      AND je2.source_type = 'bill'
      AND je2.status = 'posted'
  );

-- Void legacy trigger-created bill payment JEs (paired with a real source_type='bill_payment' JE)
UPDATE public.journal_entries je
SET status = 'voided',
    void_reason = 'Legacy duplicate trigger JE — cleaned up',
    voided_at = now(),
    updated_at = now()
WHERE je.source_type IS NULL
  AND je.status = 'posted'
  AND je.description ILIKE 'Bill payment%'
  AND EXISTS (
    SELECT 1 FROM public.journal_entries je2
    WHERE je2.organization_id = je.organization_id
      AND je2.reference = je.reference
      AND je2.source_type = 'bill_payment'
      AND je2.status = 'posted'
  );