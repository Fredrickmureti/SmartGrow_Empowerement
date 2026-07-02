-- Repair VAT/Input-Tax accounts that were seeded with detail_type
-- 'accounts_receivable'. They poison the AR role by tying with the real
-- AR account, producing weak-confidence proposals.
--
-- Idempotent: only touches rows that are misclassified.

UPDATE public.accounts
SET detail_type = 'other_current_asset'
WHERE account_type = 'asset'
  AND detail_type = 'accounts_receivable'
  AND (
       name ILIKE '%vat receivable%'
    OR name ILIKE '%input vat%'
    OR name ILIKE '%sales tax receivable%'
    OR name ILIKE '%gst receivable%'
    OR name ILIKE '%input tax%'
  );
