
-- Finance Phase 0 — branch-isolation hardening (corrected for app_role enum)
CREATE OR REPLACE FUNCTION public.has_finance_permission(
  _user_id    uuid,
  _perm       text,
  _business_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ctx AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = _user_id
          AND ur.is_active = true
          AND ur.role IN ('super_admin','owner','admin','accountant')
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      ) AS is_acct
  )
  SELECT CASE
    WHEN _perm IN (
      'finance.view_consolidated','finance.manage_je','finance.void_je',
      'finance.reconcile_bank','finance.export_reports',
      'finance.manage_settings','finance.manage_coa','finance.manage_periods'
    ) THEN (SELECT is_acct FROM ctx)
    ELSE false
  END;
$$;
GRANT EXECUTE ON FUNCTION public.has_finance_permission(uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_user_default_branch(
  _user_id uuid, _business_id uuid
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT uba.branch_id
  FROM public.user_branch_assignments uba
  JOIN public.branches b ON b.id = uba.branch_id
  WHERE uba.user_id = _user_id
    AND b.business_id = _business_id
  ORDER BY b.is_headquarters DESC, b.created_at ASC
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_default_branch(uuid,uuid) TO authenticated;

-- INVOICES
DROP POLICY IF EXISTS invoices_select_v2 ON public.invoices;
CREATE POLICY invoices_select_v2 ON public.invoices FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS invoices_update_v2 ON public.invoices;
CREATE POLICY invoices_update_v2 ON public.invoices FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS invoices_delete_v2 ON public.invoices;
CREATE POLICY invoices_delete_v2 ON public.invoices FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- PAYMENTS
DROP POLICY IF EXISTS payments_select_v2 ON public.payments;
CREATE POLICY payments_select_v2 ON public.payments FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS payments_update_v2 ON public.payments;
CREATE POLICY payments_update_v2 ON public.payments FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS payments_delete_v2 ON public.payments;
CREATE POLICY payments_delete_v2 ON public.payments FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- JOURNAL ENTRIES
DROP POLICY IF EXISTS journal_entries_select_v2 ON public.journal_entries;
CREATE POLICY journal_entries_select_v2 ON public.journal_entries FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS journal_entries_update_v2 ON public.journal_entries;
CREATE POLICY journal_entries_update_v2 ON public.journal_entries FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS journal_entries_delete_v2 ON public.journal_entries;
CREATE POLICY journal_entries_delete_v2 ON public.journal_entries FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- JOURNAL ENTRY LINES (inherit parent JE)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='journal_entry_lines' AND policyname LIKE '%v2%' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.journal_entry_lines', r.policyname);
  END LOOP;
END $$;
CREATE POLICY journal_entry_lines_select_v2 ON public.journal_entry_lines FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id
          AND user_can_access_business(auth.uid(), je.business_id)
          AND (je.branch_id IS NULL OR user_can_access_branch(auth.uid(), je.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated',je.business_id)))
);
CREATE POLICY journal_entry_lines_insert_v2 ON public.journal_entry_lines FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id
          AND user_can_access_business(auth.uid(), je.business_id)
          AND (je.branch_id IS NULL OR user_can_access_branch(auth.uid(), je.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated',je.business_id)))
);
CREATE POLICY journal_entry_lines_update_v2 ON public.journal_entry_lines FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id
          AND user_can_access_business(auth.uid(), je.business_id)
          AND (je.branch_id IS NULL OR user_can_access_branch(auth.uid(), je.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated',je.business_id)))
);
CREATE POLICY journal_entry_lines_delete_v2 ON public.journal_entry_lines FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = journal_entry_lines.journal_entry_id
          AND user_can_access_business(auth.uid(), je.business_id)
          AND (je.branch_id IS NULL OR user_can_access_branch(auth.uid(), je.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated',je.business_id)))
);

-- CREDIT NOTES
DROP POLICY IF EXISTS credit_notes_select_v2 ON public.credit_notes;
CREATE POLICY credit_notes_select_v2 ON public.credit_notes FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS credit_notes_update_v2 ON public.credit_notes;
CREATE POLICY credit_notes_update_v2 ON public.credit_notes FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS credit_notes_delete_v2 ON public.credit_notes;
CREATE POLICY credit_notes_delete_v2 ON public.credit_notes FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'sales','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- VENDOR CREDIT NOTES
DROP POLICY IF EXISTS vcn_select_v2 ON public.vendor_credit_notes;
CREATE POLICY vcn_select_v2 ON public.vendor_credit_notes FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'purchases','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS vcn_update_v2 ON public.vendor_credit_notes;
CREATE POLICY vcn_update_v2 ON public.vendor_credit_notes FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'purchases','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS vcn_delete_v2 ON public.vendor_credit_notes;
CREATE POLICY vcn_delete_v2 ON public.vendor_credit_notes FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'purchases','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- BANK ACCOUNTS
DROP POLICY IF EXISTS bank_accounts_select_perm ON public.bank_accounts;
CREATE POLICY bank_accounts_select_perm ON public.bank_accounts FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS bank_accounts_update_perm ON public.bank_accounts;
CREATE POLICY bank_accounts_update_perm ON public.bank_accounts FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS bank_accounts_delete_perm ON public.bank_accounts;
CREATE POLICY bank_accounts_delete_perm ON public.bank_accounts FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- BANK TRANSACTIONS (inherit branch via parent bank_account)
DROP POLICY IF EXISTS bank_txn_select_perm ON public.bank_transactions;
CREATE POLICY bank_txn_select_perm ON public.bank_transactions FOR SELECT USING (
  user_has_module_permission(auth.uid(), organization_id,'financials','read')
  AND EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.id = bank_transactions.bank_account_id
          AND user_can_access_business(auth.uid(), ba.business_id)
          AND (ba.branch_id IS NULL OR user_can_access_branch(auth.uid(), ba.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated', ba.business_id)))
);
DROP POLICY IF EXISTS bank_txn_update_perm ON public.bank_transactions;
CREATE POLICY bank_txn_update_perm ON public.bank_transactions FOR UPDATE USING (
  user_has_module_permission(auth.uid(), organization_id,'financials','write')
  AND EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.id = bank_transactions.bank_account_id
          AND user_can_access_business(auth.uid(), ba.business_id)
          AND (ba.branch_id IS NULL OR user_can_access_branch(auth.uid(), ba.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated', ba.business_id)))
);
DROP POLICY IF EXISTS bank_txn_delete_perm ON public.bank_transactions;
CREATE POLICY bank_txn_delete_perm ON public.bank_transactions FOR DELETE USING (
  user_has_module_permission(auth.uid(), organization_id,'financials','delete')
  AND EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.id = bank_transactions.bank_account_id
          AND user_can_access_business(auth.uid(), ba.business_id)
          AND (ba.branch_id IS NULL OR user_can_access_branch(auth.uid(), ba.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated', ba.business_id)))
);

-- FIXED ASSETS
DROP POLICY IF EXISTS fixed_assets_select_perm ON public.fixed_assets;
CREATE POLICY fixed_assets_select_perm ON public.fixed_assets FOR SELECT USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS fixed_assets_update_perm ON public.fixed_assets;
CREATE POLICY fixed_assets_update_perm ON public.fixed_assets FOR UPDATE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);
DROP POLICY IF EXISTS fixed_assets_delete_perm ON public.fixed_assets;
CREATE POLICY fixed_assets_delete_perm ON public.fixed_assets FOR DELETE USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id,'financials','delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(),'finance.view_consolidated',business_id))
);

-- DEPRECIATION ENTRIES (inherit asset)
DROP POLICY IF EXISTS org_depreciation_entries_select ON public.depreciation_entries;
CREATE POLICY depreciation_entries_select_v2 ON public.depreciation_entries FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.fixed_assets fa WHERE fa.id = depreciation_entries.asset_id
          AND user_can_access_business(auth.uid(), fa.business_id)
          AND (fa.branch_id IS NULL OR user_can_access_branch(auth.uid(), fa.branch_id)
               OR has_finance_permission(auth.uid(),'finance.view_consolidated', fa.business_id)))
);

-- Sanity assertion
DO $$
DECLARE missing int := 0;
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','payments','journal_entries','credit_notes',
                    'vendor_credit_notes','bank_accounts','fixed_assets'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename = t
        AND qual LIKE '%user_can_access_branch%'
    ) THEN
      missing := missing + 1;
      RAISE NOTICE 'Table % still lacks branch check', t;
    END IF;
  END LOOP;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Phase 0 RLS hardening incomplete: % tables still lack branch check', missing;
  END IF;
END $$;
