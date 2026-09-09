CREATE TABLE public.mf_client_charge_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  charge_id uuid NOT NULL REFERENCES public.mf_client_charges(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.mf_clients(id) ON DELETE RESTRICT,
  collection_id uuid,
  amount numeric(18,2) NOT NULL,
  paid_on date NOT NULL DEFAULT CURRENT_DATE,
  method text NOT NULL DEFAULT 'cash',
  reference text,
  receipt_number text,
  status text NOT NULL DEFAULT 'posted',
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversal_reason text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_ccp_amount_positive CHECK (amount > 0),
  CONSTRAINT mf_ccp_status_known CHECK (status IN ('posted','reversed'))
);

COMMENT ON TABLE public.mf_client_charge_payments IS
  'Settlement ledger for client-level charges. A payment always settles exactly one client charge; collection_id groups payments handed over together at a group meeting. The client remains the economic subject of the fee.';

CREATE UNIQUE INDEX mf_ccp_receipt_unique
  ON public.mf_client_charge_payments (business_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

CREATE INDEX mf_ccp_charge_idx ON public.mf_client_charge_payments (charge_id, status);
CREATE INDEX mf_ccp_collection_idx ON public.mf_client_charge_payments (collection_id);
CREATE INDEX mf_ccp_client_idx ON public.mf_client_charge_payments (client_id, status);

GRANT SELECT, INSERT, UPDATE ON public.mf_client_charge_payments TO authenticated;
GRANT ALL ON public.mf_client_charge_payments TO service_role;

ALTER TABLE public.mf_client_charge_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_ccp_read ON public.mf_client_charge_payments
  FOR SELECT TO authenticated
  USING (public.mf_can(business_id, branch_id, 'clients', 'read'));

CREATE POLICY mf_ccp_insert ON public.mf_client_charge_payments
  FOR INSERT TO authenticated
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'create'));

CREATE POLICY mf_ccp_update ON public.mf_client_charge_payments
  FOR UPDATE TO authenticated
  USING (public.mf_can(business_id, branch_id, 'repayments', 'write'))
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'write'));

CREATE TRIGGER mf_ccp_touch
  BEFORE UPDATE ON public.mf_client_charge_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();