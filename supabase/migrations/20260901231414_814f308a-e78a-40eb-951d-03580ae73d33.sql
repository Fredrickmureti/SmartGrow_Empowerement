-- ============ allocation policy (configuration, never hardcoded) ============
CREATE TABLE public.mf_allocation_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE,
  allocation_order text[] NOT NULL DEFAULT ARRAY['penalty','fee','interest','principal']::text[],
  allow_overpayment boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_allocation_policy_order_chk CHECK (
    allocation_order <@ ARRAY['penalty','fee','interest','principal']::text[]
    AND array_length(allocation_order,1) = 4
  )
);
GRANT SELECT, INSERT, UPDATE ON public.mf_allocation_policy TO authenticated;
GRANT ALL ON public.mf_allocation_policy TO service_role;
ALTER TABLE public.mf_allocation_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_allocation_policy_read ON public.mf_allocation_policy FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));
CREATE POLICY mf_allocation_policy_write ON public.mf_allocation_policy FOR ALL TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')));

-- ============ collection batches (one per meeting / cashier session) ============
CREATE TABLE public.mf_repayment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  group_id uuid REFERENCES public.mf_groups(id),
  batch_number text NOT NULL,
  collected_on date NOT NULL DEFAULT CURRENT_DATE,
  collected_by uuid,
  status text NOT NULL DEFAULT 'open',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_repayment_batches_number_uniq UNIQUE (business_id, batch_number),
  CONSTRAINT mf_repayment_batches_status_chk CHECK (status IN ('open','closed'))
);
CREATE INDEX mf_repayment_batches_date_idx ON public.mf_repayment_batches(business_id, collected_on DESC);
GRANT SELECT, INSERT, UPDATE ON public.mf_repayment_batches TO authenticated;
GRANT ALL ON public.mf_repayment_batches TO service_role;
ALTER TABLE public.mf_repayment_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_repayment_batches_read ON public.mf_repayment_batches FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));
CREATE POLICY mf_repayment_batches_insert ON public.mf_repayment_batches FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')
      OR has_role(auth.uid(),'collections_officer') OR has_role(auth.uid(),'loan_officer')));
CREATE POLICY mf_repayment_batches_update ON public.mf_repayment_batches FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')
      OR has_role(auth.uid(),'collections_officer') OR has_role(auth.uid(),'loan_officer')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

-- ============ repayments (receipts) ============
CREATE TABLE public.mf_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  batch_id uuid REFERENCES public.mf_repayment_batches(id),
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id),
  client_id uuid NOT NULL REFERENCES public.mf_clients(id),
  receipt_number text NOT NULL,
  paid_on date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  reference text,
  status text NOT NULL DEFAULT 'posted',
  reversal_reason text,
  reversed_at timestamptz,
  reversed_by uuid,
  received_by uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_repayments_receipt_uniq UNIQUE (business_id, receipt_number),
  CONSTRAINT mf_repayments_status_chk CHECK (status IN ('posted','reversed')),
  CONSTRAINT mf_repayments_method_chk CHECK (method IN ('cash','bank_transfer','mobile_money','cheque'))
);
CREATE INDEX mf_repayments_loan_idx ON public.mf_repayments(loan_id, paid_on);
CREATE INDEX mf_repayments_batch_idx ON public.mf_repayments(batch_id);
CREATE INDEX mf_repayments_date_idx ON public.mf_repayments(business_id, paid_on DESC);
GRANT SELECT, INSERT, UPDATE ON public.mf_repayments TO authenticated;
GRANT ALL ON public.mf_repayments TO service_role;
ALTER TABLE public.mf_repayments ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_repayments_read ON public.mf_repayments FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));
CREATE POLICY mf_repayments_insert ON public.mf_repayments FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')
      OR has_role(auth.uid(),'collections_officer') OR has_role(auth.uid(),'loan_officer')));
CREATE POLICY mf_repayments_update ON public.mf_repayments FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
      OR has_role(auth.uid(),'branch_manager')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

-- ============ allocations (server-written only) ============
CREATE TABLE public.mf_repayment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  repayment_id uuid NOT NULL REFERENCES public.mf_repayments(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id),
  installment_no integer,
  component text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_repayment_allocations_component_chk
    CHECK (component IN ('penalty','fee','interest','principal','advance'))
);
CREATE INDEX mf_repayment_allocations_loan_idx ON public.mf_repayment_allocations(loan_id, installment_no);
CREATE INDEX mf_repayment_allocations_repayment_idx ON public.mf_repayment_allocations(repayment_id);
GRANT SELECT ON public.mf_repayment_allocations TO authenticated;
GRANT ALL ON public.mf_repayment_allocations TO service_role;
ALTER TABLE public.mf_repayment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY mf_repayment_allocations_read ON public.mf_repayment_allocations FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

-- updated_at triggers reuse the existing helper
CREATE TRIGGER mf_allocation_policy_touch BEFORE UPDATE ON public.mf_allocation_policy
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER mf_repayment_batches_touch BEFORE UPDATE ON public.mf_repayment_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER mf_repayments_touch BEFORE UPDATE ON public.mf_repayments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();