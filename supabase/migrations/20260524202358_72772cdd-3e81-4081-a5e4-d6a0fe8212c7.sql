
DROP POLICY IF EXISTS "Users can manage splits for their org transactions" ON public.bank_transaction_splits;
CREATE POLICY "Users can manage splits for their org transactions"
ON public.bank_transaction_splits FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.bank_transactions bt
  JOIN public.user_roles ur ON ur.user_id = auth.uid()
    AND ur.organization_id = bt.organization_id
    AND ur.is_active = true
  WHERE bt.id = bank_transaction_splits.bank_transaction_id))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.bank_transactions bt
  JOIN public.user_roles ur ON ur.user_id = auth.uid()
    AND ur.organization_id = bt.organization_id
    AND ur.is_active = true
  WHERE bt.id = bank_transaction_splits.bank_transaction_id));

DROP POLICY IF EXISTS "payroll_statutory_rules_all" ON public.payroll_statutory_rules;
DROP POLICY IF EXISTS "payroll_statutory_rules_select" ON public.payroll_statutory_rules;

CREATE POLICY "payroll_statutory_rules_select"
ON public.payroll_statutory_rules FOR SELECT
USING (organization_id IN (
  SELECT ur.organization_id FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_active = true));

CREATE POLICY "payroll_statutory_rules_insert"
ON public.payroll_statutory_rules FOR INSERT
WITH CHECK (
  public.has_payroll_access(auth.uid(), organization_id)
  OR public.has_role(auth.uid(), 'owner')
  OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "payroll_statutory_rules_update"
ON public.payroll_statutory_rules FOR UPDATE
USING (
  public.has_payroll_access(auth.uid(), organization_id)
  OR public.has_role(auth.uid(), 'owner')
  OR public.has_role(auth.uid(), 'admin'))
WITH CHECK (
  public.has_payroll_access(auth.uid(), organization_id)
  OR public.has_role(auth.uid(), 'owner')
  OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "payroll_statutory_rules_delete"
ON public.payroll_statutory_rules FOR DELETE
USING (
  public.has_payroll_access(auth.uid(), organization_id)
  OR public.has_role(auth.uid(), 'owner')
  OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Authenticated users can read admin alerts" ON public.platform_admin_alerts;
CREATE POLICY "Platform admins can read admin alerts"
ON public.platform_admin_alerts FOR SELECT
USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;

CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'user-avatars'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'user-avatars'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (
  bucket_id = 'user-avatars'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'user-avatars'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] = auth.uid()::text);
