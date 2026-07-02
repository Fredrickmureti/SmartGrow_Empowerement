
-- ============================================================
-- 1) Replace broken correlated-subquery RLS policies (8 tables)
-- ============================================================

-- vendor_credit_note_applications
DROP POLICY IF EXISTS "Users can view their org vendor credit note applications" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can manage their org vendor credit note applications" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can insert their org vendor credit note applications" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can update their org vendor credit note applications" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can delete their org vendor credit note applications" ON public.vendor_credit_note_applications;
CREATE POLICY "vendor_credit_note_applications_org_all"
  ON public.vendor_credit_note_applications
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- compliance_checklist
DROP POLICY IF EXISTS "Users can manage their org compliance checklist" ON public.compliance_checklist;
DROP POLICY IF EXISTS "Users can view their org compliance checklist" ON public.compliance_checklist;
CREATE POLICY "compliance_checklist_org_all"
  ON public.compliance_checklist
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- core_field_overrides
DROP POLICY IF EXISTS "Users can manage their org core field overrides" ON public.core_field_overrides;
DROP POLICY IF EXISTS "Users can view their org core field overrides" ON public.core_field_overrides;
CREATE POLICY "core_field_overrides_org_all"
  ON public.core_field_overrides
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- automation_execution_tracker
DROP POLICY IF EXISTS "Users can view their org automation execution tracker" ON public.automation_execution_tracker;
CREATE POLICY "automation_execution_tracker_org_select"
  ON public.automation_execution_tracker
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- report_generation_logs
DROP POLICY IF EXISTS "Users can view their org report generation logs" ON public.report_generation_logs;
DROP POLICY IF EXISTS "Users can manage their org report generation logs" ON public.report_generation_logs;
DROP POLICY IF EXISTS "Users can insert their org report generation logs" ON public.report_generation_logs;
CREATE POLICY "report_generation_logs_org_select"
  ON public.report_generation_logs
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));
CREATE POLICY "report_generation_logs_org_insert"
  ON public.report_generation_logs
  FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- departments (drop the broken view-all overlay; module-permission policies remain)
DROP POLICY IF EXISTS "Users can view departments in their organization" ON public.departments;

-- reconciliation_sessions
DROP POLICY IF EXISTS "Users can view their org reconciliation sessions" ON public.reconciliation_sessions;
DROP POLICY IF EXISTS "Users can manage their org reconciliation sessions" ON public.reconciliation_sessions;
CREATE POLICY "reconciliation_sessions_org_all"
  ON public.reconciliation_sessions
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- project_templates
DROP POLICY IF EXISTS "project_templates_org_read" ON public.project_templates;
DROP POLICY IF EXISTS "project_templates_org_write" ON public.project_templates;
CREATE POLICY "project_templates_org_select"
  ON public.project_templates
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));
CREATE POLICY "project_templates_org_write"
  ON public.project_templates
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- ============================================================
-- 2) Restrict encrypted-credential tables
-- ============================================================

-- platform_bank_providers — drop broad authenticated SELECT
DROP POLICY IF EXISTS "Authenticated users can view enabled bank providers" ON public.platform_bank_providers;
-- Keep: "Manual provider always visible", "Platform admins can manage bank providers"

-- sms_provider_configs — restrict SELECT to owners/admins
DROP POLICY IF EXISTS "Org members can view their SMS provider config" ON public.sms_provider_configs;
DROP POLICY IF EXISTS "Org members can view SMS provider config" ON public.sms_provider_configs;
DROP POLICY IF EXISTS "Users can view their org SMS provider configs" ON public.sms_provider_configs;
CREATE POLICY "sms_provider_configs_admin_select"
  ON public.sms_provider_configs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  );

-- organization_payment_gateways — restrict SELECT to owners/admins
DROP POLICY IF EXISTS "Organization members can view their payment gateways" ON public.organization_payment_gateways;
CREATE POLICY "organization_payment_gateways_admin_select"
  ON public.organization_payment_gateways
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  );

-- ============================================================
-- 3) Tighten storage bucket policies (org-scoped path)
-- ============================================================

-- employee-documents: SELECT, INSERT, DELETE must be in user's org folder
DROP POLICY IF EXISTS "Authenticated users can view employee documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload employee documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete employee documents" ON storage.objects;

CREATE POLICY "employee_documents_org_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'employee-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "employee_documents_org_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'employee-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "employee_documents_org_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'employee-documents'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- employee-avatars: tighten UPDATE/DELETE to org folder
DROP POLICY IF EXISTS "Employees can update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Employees can delete own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Employees can upload own avatar" ON storage.objects;

CREATE POLICY "employee_avatars_org_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'employee-avatars'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "employee_avatars_org_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'employee-avatars'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    bucket_id = 'employee-avatars'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "employee_avatars_org_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'employee-avatars'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );
