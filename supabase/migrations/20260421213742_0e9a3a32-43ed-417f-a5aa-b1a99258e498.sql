
-- ============================================================
-- Phase B + C — Multi-tenant scope hardening
-- Add business_id (Phase B) + branch_id where operational (Phase C)
-- to every table that was previously org-only but represents
-- res.company / res.branch data in Odoo terms.
-- ============================================================

-- Helper: backfill business_id from the single primary business of an org.
-- Safe because (a) businesses is currently empty so most rows are also empty,
-- and (b) for any tenant with rows present we map every row to that org's
-- HQ company. Multi-company tenants do not yet exist in this DB.
CREATE OR REPLACE FUNCTION public._backfill_business_id(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE format($f$
    UPDATE public.%I t
    SET business_id = b.id
    FROM public.businesses b
    WHERE t.business_id IS NULL
      AND t.organization_id = b.organization_id
      AND b.id = (
        SELECT id FROM public.businesses
        WHERE organization_id = t.organization_id
        ORDER BY created_at ASC
        LIMIT 1
      );
  $f$, p_table);
END;
$$;

-- ============================================================
-- PHASE B — add business_id to res.company-scoped tables
-- ============================================================

-- POS (state + config) — most contamination risk
ALTER TABLE public.pos_settings              ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_tables                ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_gl_mappings           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_cashiers              ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_hardware_configs      ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_security_settings     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_discounts             ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_happy_hours           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_kitchen_orders        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_modifier_groups       ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_modifiers             ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_split_bills           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_table_sessions        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_courses               ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_held_transactions     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_manager_overrides     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_table_bookings        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_table_transfers       ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_stock_reservations    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_cash_movements        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_approval_requests     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_gift_cards            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.pos_gift_card_transactions ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Payroll / HR (res.company)
ALTER TABLE public.salary_components             ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.payroll_statutory_rules       ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.payroll_statutory_rates       ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.payroll_rule_types            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.benefit_plans                 ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.leave_types                   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.public_holidays               ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.timesheet_settings            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.employee_documents            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.employee_field_configs        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.employee_onboarding           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.employee_statutory_identifiers ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.onboarding_templates          ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Tax / Compliance (res.company)
ALTER TABLE public.tax_account_mappings   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.tax_compliance_configs ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.tax_report_templates   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.etims_tax_categories   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.etims_transmission_logs ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.mpesa_c2b_transactions ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Inventory (res.company catalog + branch ops)
ALTER TABLE public.warehouse_stock     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.stock_transfers     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.product_categories  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.promotions          ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Reporting & Automation (res.company)
ALTER TABLE public.scheduled_reports         ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.saved_views               ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.report_saved_views        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.report_generation_logs    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.automated_action_logs     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.transaction_categorization_rules ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.depreciation_schedules    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.approval_requests         ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.approval_rule_logs        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.approval_rules            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Documents / Signing (res.company)
ALTER TABLE public.signature_requests         ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.signature_templates        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.documents_shares           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.documents_requests         ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.documents_folder_tags      ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.documents_workflow_actions ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.document_comments          ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.document_emails            ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Settings / Communication (res.company)
ALTER TABLE public.payment_provider_configs    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.notification_preferences    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.notification_digest_queue   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.sms_templates               ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.sms_event_rules             ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.sms_opt_outs                ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_reminders           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_emails              ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_activities          ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.organization_api_integrations ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- AR/AP supporting
ALTER TABLE public.vendor_credit_note_applications ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.vendor_portal_invitations       ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.project_tasks                   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- Backfill all of the above (no-op when org has no businesses yet)
DO $$
DECLARE t text; tables text[] := ARRAY[
  'pos_settings','pos_tables','pos_gl_mappings','pos_cashiers','pos_hardware_configs','pos_security_settings',
  'pos_discounts','pos_happy_hours','pos_kitchen_orders','pos_modifier_groups','pos_modifiers','pos_split_bills',
  'pos_table_sessions','pos_courses','pos_held_transactions','pos_manager_overrides','pos_table_bookings',
  'pos_table_transfers','pos_stock_reservations','pos_cash_movements','pos_approval_requests',
  'pos_gift_cards','pos_gift_card_transactions',
  'salary_components','payroll_statutory_rules','payroll_statutory_rates','payroll_rule_types','benefit_plans',
  'leave_types','public_holidays','timesheet_settings','employee_documents','employee_field_configs',
  'employee_onboarding','employee_statutory_identifiers','onboarding_templates',
  'tax_account_mappings','tax_compliance_configs','tax_report_templates','etims_tax_categories',
  'etims_transmission_logs','mpesa_c2b_transactions',
  'warehouse_stock','stock_transfers','product_categories','promotions',
  'scheduled_reports','saved_views','report_saved_views','report_generation_logs','automated_action_logs',
  'transaction_categorization_rules','depreciation_schedules','approval_requests','approval_rule_logs','approval_rules',
  'signature_requests','signature_templates','documents_shares','documents_requests','documents_folder_tags',
  'documents_workflow_actions','document_comments','document_emails',
  'payment_provider_configs','notification_preferences','notification_digest_queue','sms_templates',
  'sms_event_rules','sms_opt_outs','invoice_reminders','invoice_emails','invoice_activities',
  'organization_api_integrations','vendor_credit_note_applications','vendor_portal_invitations','project_tasks'
];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    PERFORM public._backfill_business_id(t);
  END LOOP;
END $$;

-- Note: We deliberately do NOT enforce NOT NULL yet. This will be done in a
-- follow-up migration after application code is updated to always supply
-- business_id on insert (Phase B-2). NOT NULL on a column the app may not yet
-- populate would break inserts in flight. The new RLS policies (below) require
-- business_id matching, which gives us correctness at the read path immediately.

-- ============================================================
-- PHASE C — add branch_id to operational tables that should isolate per branch
-- ============================================================
ALTER TABLE public.pos_settings              ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_tables                ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_cashiers              ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_hardware_configs      ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_security_settings     ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_held_transactions     ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_kitchen_orders        ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_table_sessions        ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_cash_movements        ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_stock_reservations    ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_table_bookings        ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_split_bills           ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.pos_manager_overrides     ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.warehouse_stock           ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.stock_transfers           ADD COLUMN IF NOT EXISTS from_branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
ALTER TABLE public.stock_transfers           ADD COLUMN IF NOT EXISTS to_branch_id   uuid REFERENCES public.branches(id) ON DELETE SET NULL;

-- Indexes for the new scoping columns (all org+business heavy tables)
CREATE INDEX IF NOT EXISTS idx_pos_settings_org_biz ON public.pos_settings(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_pos_tables_org_biz ON public.pos_tables(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_pos_cashiers_org_biz ON public.pos_cashiers(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_org_biz ON public.warehouse_stock(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_org_biz ON public.stock_transfers(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_salary_components_org_biz ON public.salary_components(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_leave_types_org_biz ON public.leave_types(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_tax_account_mappings_org_biz ON public.tax_account_mappings(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org_biz ON public.scheduled_reports(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_saved_views_org_biz ON public.saved_views(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_org_biz ON public.signature_requests(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_invoice_activities_org_biz ON public.invoice_activities(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_branch ON public.pos_table_sessions(branch_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_branch ON public.warehouse_stock(branch_id);

-- Drop the helper now that we're done
DROP FUNCTION IF EXISTS public._backfill_business_id(text);

-- ============================================================
-- PHASE E.1 — Subscription enforcement: block status-changing UPDATE
-- on invoices/bills/journal_entries when subscription expired.
-- (B8 finding: previously INSERT-only.)
-- ============================================================
CREATE OR REPLACE FUNCTION public.subscription_active_for_org(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_org
      AND (
        subscription_status IN ('active','trialing')
        OR (trial_ends_at IS NOT NULL AND trial_ends_at > now())
      )
  );
$$;

-- Apply blocking UPDATE policies on the three booking tables.
-- These ride alongside existing policies (PERMISSIVE OR semantics): if any
-- other UPDATE policy returns true the row passes; we add a RESTRICTIVE
-- policy so this one MUST also pass.
DO $$
BEGIN
  -- invoices
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='invoices' AND policyname='block_invoice_update_expired_sub') THEN
    EXECUTE $p$
      CREATE POLICY block_invoice_update_expired_sub ON public.invoices
      AS RESTRICTIVE
      FOR UPDATE TO authenticated
      USING (public.subscription_active_for_org(organization_id))
      WITH CHECK (public.subscription_active_for_org(organization_id));
    $p$;
  END IF;
  -- bills
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='bills' AND policyname='block_bill_update_expired_sub') THEN
    EXECUTE $p$
      CREATE POLICY block_bill_update_expired_sub ON public.bills
      AS RESTRICTIVE
      FOR UPDATE TO authenticated
      USING (public.subscription_active_for_org(organization_id))
      WITH CHECK (public.subscription_active_for_org(organization_id));
    $p$;
  END IF;
  -- journal_entries
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='journal_entries' AND policyname='block_je_update_expired_sub') THEN
    EXECUTE $p$
      CREATE POLICY block_je_update_expired_sub ON public.journal_entries
      AS RESTRICTIVE
      FOR UPDATE TO authenticated
      USING (public.subscription_active_for_org(organization_id))
      WITH CHECK (public.subscription_active_for_org(organization_id));
    $p$;
  END IF;
END $$;
