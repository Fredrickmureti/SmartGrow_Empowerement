-- ============================================================================
-- PHASE J — Schema completions
-- ============================================================================

-- 1. tax_groups
ALTER TABLE public.tax_groups
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

UPDATE public.tax_groups tg
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, id
  FROM public.businesses
  ORDER BY organization_id, created_at ASC
) b
WHERE tg.business_id IS NULL AND tg.organization_id = b.organization_id;

DELETE FROM public.tax_groups WHERE business_id IS NULL;

ALTER TABLE public.tax_groups
  ALTER COLUMN business_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tax_groups_business ON public.tax_groups(business_id);

-- 2. invoice_sequences
UPDATE public.invoice_sequences s
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, id
  FROM public.businesses
  ORDER BY organization_id, created_at ASC
) b
WHERE s.business_id IS NULL AND s.organization_id = b.organization_id;

DELETE FROM public.invoice_sequences WHERE business_id IS NULL;

ALTER TABLE public.invoice_sequences
  ALTER COLUMN business_id SET NOT NULL;

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.invoice_sequences'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.invoice_sequences DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_sequences_biz_year
  ON public.invoice_sequences(business_id, year);

-- 3. je_number_sequences
UPDATE public.je_number_sequences s
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, id
  FROM public.businesses
  ORDER BY organization_id, created_at ASC
) b
WHERE s.business_id IS NULL AND s.organization_id = b.organization_id;

DELETE FROM public.je_number_sequences WHERE business_id IS NULL;

ALTER TABLE public.je_number_sequences
  ALTER COLUMN business_id SET NOT NULL;

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.je_number_sequences'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.je_number_sequences DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_je_sequences_biz
  ON public.je_number_sequences(business_id);

-- 4. default_account_settings
UPDATE public.default_account_settings s
SET business_id = b.id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, id
  FROM public.businesses
  ORDER BY organization_id, created_at ASC
) b
WHERE s.business_id IS NULL AND s.organization_id = b.organization_id;

DELETE FROM public.default_account_settings WHERE business_id IS NULL;

ALTER TABLE public.default_account_settings
  ALTER COLUMN business_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_account_settings_biz_key
  ON public.default_account_settings(business_id, setting_key);

-- 5. is_shared flag
ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;

ALTER TABLE public.organization_payment_methods
  ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;

-- ============================================================================
-- PHASE I — RLS hardening
-- ============================================================================

-- bank_accounts
DROP POLICY IF EXISTS bank_accounts_select_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_insert_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_update_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_delete_perm ON public.bank_accounts;

CREATE POLICY bank_accounts_select_perm ON public.bank_accounts
  FOR SELECT USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read')
  );
CREATE POLICY bank_accounts_insert_perm ON public.bank_accounts
  FOR INSERT WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create')
  );
CREATE POLICY bank_accounts_update_perm ON public.bank_accounts
  FOR UPDATE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
  );
CREATE POLICY bank_accounts_delete_perm ON public.bank_accounts
  FOR DELETE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete')
  );

-- document_templates
DROP POLICY IF EXISTS "Users can view templates in their organization" ON public.document_templates;
DROP POLICY IF EXISTS "Users can create templates in their organization" ON public.document_templates;
DROP POLICY IF EXISTS "Users can update templates in their organization" ON public.document_templates;
DROP POLICY IF EXISTS "Users can delete templates in their organization" ON public.document_templates;

CREATE POLICY document_templates_select ON public.document_templates
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY document_templates_insert ON public.document_templates
  FOR INSERT WITH CHECK (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY document_templates_update ON public.document_templates
  FOR UPDATE USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY document_templates_delete ON public.document_templates
  FOR DELETE USING (public.user_can_access_business(auth.uid(), business_id));

-- email_templates
DROP POLICY IF EXISTS "Users can view email templates in their orgs" ON public.email_templates;
DROP POLICY IF EXISTS "Users can manage email templates in their orgs" ON public.email_templates;

CREATE POLICY email_templates_select ON public.email_templates
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY email_templates_all ON public.email_templates
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- exchange_rates
DROP POLICY IF EXISTS "Users can view exchange rates in their orgs" ON public.exchange_rates;
DROP POLICY IF EXISTS "Users can manage exchange rates in their orgs" ON public.exchange_rates;

CREATE POLICY exchange_rates_select ON public.exchange_rates
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY exchange_rates_all ON public.exchange_rates
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- default_account_settings
DROP POLICY IF EXISTS "Users can view default account settings for their org" ON public.default_account_settings;
DROP POLICY IF EXISTS "Users can manage default account settings for their org" ON public.default_account_settings;

CREATE POLICY default_account_settings_select ON public.default_account_settings
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY default_account_settings_all ON public.default_account_settings
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- installed_localization_packs
DROP POLICY IF EXISTS "Users can view their org installed packs" ON public.installed_localization_packs;
DROP POLICY IF EXISTS "Users can install packs for their org" ON public.installed_localization_packs;

CREATE POLICY installed_packs_select ON public.installed_localization_packs
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY installed_packs_insert ON public.installed_localization_packs
  FOR INSERT WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- business_active_currencies
DROP POLICY IF EXISTS "Members can view active currencies" ON public.business_active_currencies;
DROP POLICY IF EXISTS "Admins can manage active currencies" ON public.business_active_currencies;

CREATE POLICY active_currencies_select ON public.business_active_currencies
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY active_currencies_all ON public.business_active_currencies
  FOR ALL USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  ) WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  );

-- payment_terms
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='payment_terms'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payment_terms', p.policyname);
  END LOOP;
END $$;

CREATE POLICY payment_terms_select ON public.payment_terms
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY payment_terms_all ON public.payment_terms
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- invoice_sequences
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='invoice_sequences'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.invoice_sequences', p.policyname);
  END LOOP;
END $$;

CREATE POLICY invoice_sequences_select ON public.invoice_sequences
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY invoice_sequences_insert ON public.invoice_sequences
  FOR INSERT WITH CHECK (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY invoice_sequences_update ON public.invoice_sequences
  FOR UPDATE USING (public.user_can_access_business(auth.uid(), business_id));

-- je_number_sequences
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='je_number_sequences'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.je_number_sequences', p.policyname);
  END LOOP;
END $$;

CREATE POLICY je_sequences_select ON public.je_number_sequences
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY je_sequences_insert ON public.je_number_sequences
  FOR INSERT WITH CHECK (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY je_sequences_update ON public.je_number_sequences
  FOR UPDATE USING (public.user_can_access_business(auth.uid(), business_id));

-- organization_payment_methods
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='organization_payment_methods'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.organization_payment_methods', p.policyname);
  END LOOP;
END $$;

CREATE POLICY org_payment_methods_select ON public.organization_payment_methods
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY org_payment_methods_all ON public.organization_payment_methods
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

-- tax_groups (now business-scoped)
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='tax_groups'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.tax_groups', p.policyname);
  END LOOP;
END $$;

CREATE POLICY tax_groups_select ON public.tax_groups
  FOR SELECT USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY tax_groups_all ON public.tax_groups
  FOR ALL USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));