UPDATE public.journal_entries je
SET status = 'voided',
    voided_at = COALESCE(je.voided_at, i.voided_at, now()),
    voided_by = COALESCE(je.voided_by, i.voided_by),
    void_reason = COALESCE(je.void_reason, i.void_reason, 'Auto-repair: invoice already voided')
FROM public.invoices i
WHERE i.status = 'voided'
  AND i.journal_entry_id = je.id
  AND je.status = 'posted';