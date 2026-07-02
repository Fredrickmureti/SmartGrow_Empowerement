-- Backfill: copy existing 'output_tax' mapping to 'tax_payable' where missing.
-- Idempotent: only inserts when 'tax_payable' is not already set for that org+business.
INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id, updated_at)
SELECT s.organization_id, s.business_id, 'tax_payable', s.account_id, now()
FROM public.default_account_settings s
WHERE s.setting_key = 'output_tax'
  AND s.account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.default_account_settings t
    WHERE t.organization_id = s.organization_id
      AND COALESCE(t.business_id::text, '') = COALESCE(s.business_id::text, '')
      AND t.setting_key = 'tax_payable'
  );