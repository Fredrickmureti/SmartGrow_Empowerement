CREATE TABLE public.mf_account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  mapping_key text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_account_mappings_key_valid CHECK (mapping_key IN (
    'principal_receivable','interest_income','interest_receivable','fee_income',
    'penalty_income','cash','bank','mobile_money','write_off_expense',
    'loan_loss_provision','suspended_interest'
  ))
);

CREATE UNIQUE INDEX mf_account_mappings_scope_key
  ON public.mf_account_mappings (business_id, mapping_key, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_account_mappings TO authenticated;
GRANT ALL ON public.mf_account_mappings TO service_role;

ALTER TABLE public.mf_account_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mf_account_mappings_read" ON public.mf_account_mappings
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "mf_account_mappings_write" ON public.mf_account_mappings
  FOR ALL TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'accountant'))
  )
  WITH CHECK (
    public.user_has_business_access(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'accountant'))
  );

CREATE TRIGGER mf_account_mappings_touch
  BEFORE UPDATE ON public.mf_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();