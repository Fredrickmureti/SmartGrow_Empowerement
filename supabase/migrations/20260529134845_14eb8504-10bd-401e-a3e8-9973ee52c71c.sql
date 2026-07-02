
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS template_account_id uuid
    REFERENCES public.default_chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_pack_account_id uuid
    REFERENCES public.localization_pack_account_templates(id) ON DELETE SET NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_template_provenance_xor;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_template_provenance_xor
  CHECK (template_account_id IS NULL OR template_pack_account_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_business_template_default
  ON public.accounts (business_id, template_account_id)
  WHERE template_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_business_template_pack
  ON public.accounts (business_id, template_pack_account_id)
  WHERE template_pack_account_id IS NOT NULL;

UPDATE public.accounts a
SET template_account_id = d.id
FROM public.default_chart_of_accounts d
WHERE a.template_account_id IS NULL
  AND a.template_pack_account_id IS NULL
  AND d.is_country_neutral = TRUE
  AND d.account_code::text = a.code
  AND d.account_type::text = a.account_type::text
  AND NOT EXISTS (
    SELECT 1
    FROM public.localization_pack_account_templates p
    WHERE p.code::text = a.code AND p.account_type::text = a.account_type::text
  );

DROP POLICY IF EXISTS aireports_insert_admins ON public.accounting_integrity_reports;
CREATE POLICY aireports_insert_admins
ON public.accounting_integrity_reports
FOR INSERT
WITH CHECK (
  business_id IS NULL
  OR public.has_finance_permission(auth.uid(), 'finance.manage', business_id)
);

DROP POLICY IF EXISTS aireports_update_admins ON public.accounting_integrity_reports;
CREATE POLICY aireports_update_admins
ON public.accounting_integrity_reports
FOR UPDATE
USING (
  business_id IS NULL
  OR public.has_finance_permission(auth.uid(), 'finance.manage', business_id)
);

DROP POLICY IF EXISTS aireports_delete_admins ON public.accounting_integrity_reports;
CREATE POLICY aireports_delete_admins
ON public.accounting_integrity_reports
FOR DELETE
USING (
  business_id IS NULL
  OR public.has_finance_permission(auth.uid(), 'finance.manage', business_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_integrity_reports TO authenticated;
GRANT ALL ON public.accounting_integrity_reports TO service_role;
