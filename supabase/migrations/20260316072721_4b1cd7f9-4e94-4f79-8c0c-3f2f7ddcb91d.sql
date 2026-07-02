
-- Fix bank_statements RLS: align with bank_accounts/bank_transactions pattern
-- Drop old profile-based policies
DROP POLICY IF EXISTS "Users can view bank statements in their org" ON public.bank_statements;
DROP POLICY IF EXISTS "Users can insert bank statements in their org" ON public.bank_statements;
DROP POLICY IF EXISTS "Users can update bank statements in their org" ON public.bank_statements;

-- Create new policies using user_has_module_permission (matching bank_accounts/bank_transactions)
CREATE POLICY "bank_statements_select_perm" ON public.bank_statements
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read'));

CREATE POLICY "bank_statements_insert_perm" ON public.bank_statements
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create'));

CREATE POLICY "bank_statements_update_perm" ON public.bank_statements
  FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write'));

CREATE POLICY "bank_statements_delete_perm" ON public.bank_statements
  FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete'));

-- Add missing columns to bank_statements for better audit tracking
ALTER TABLE public.bank_statements 
  ADD COLUMN IF NOT EXISTS file_format text,
  ADD COLUMN IF NOT EXISTS failed_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_count integer DEFAULT 0;
