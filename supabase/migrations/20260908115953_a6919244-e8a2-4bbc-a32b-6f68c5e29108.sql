CREATE TABLE public.mf_client_charges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES public.mf_clients(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'admission_fee',
  charged_on date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(18,2) NOT NULL,
  currency_code text NOT NULL,
  status text NOT NULL DEFAULT 'outstanding',
  receipt_number text,
  paid_on date,
  method text,
  reference text,
  notes text,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversal_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_client_charges_amount_positive CHECK (amount > 0),
  CONSTRAINT mf_client_charges_kind_known CHECK (kind IN ('admission_fee')),
  CONSTRAINT mf_client_charges_status_known CHECK (status IN ('outstanding','paid','reversed'))
);

COMMENT ON TABLE public.mf_client_charges IS
  'One-time client-level charges (ASA Kenya member admission fee). Institution income, never a client deposit, never a group fee, never a loan schedule line.';

CREATE UNIQUE INDEX mf_client_charges_one_open_per_kind
  ON public.mf_client_charges (client_id, kind)
  WHERE status <> 'reversed';

CREATE UNIQUE INDEX mf_client_charges_receipt_unique
  ON public.mf_client_charges (business_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

CREATE UNIQUE INDEX mf_client_charges_reference_unique
  ON public.mf_client_charges (business_id, reference)
  WHERE reference IS NOT NULL AND status = 'paid';

CREATE INDEX mf_client_charges_client_idx ON public.mf_client_charges (client_id, status);

GRANT SELECT, INSERT, UPDATE ON public.mf_client_charges TO authenticated;
GRANT ALL ON public.mf_client_charges TO service_role;

ALTER TABLE public.mf_client_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_client_charges_read ON public.mf_client_charges
  FOR SELECT TO authenticated
  USING (public.mf_can(business_id, branch_id, 'clients', 'read'));

CREATE POLICY mf_client_charges_insert ON public.mf_client_charges
  FOR INSERT TO authenticated
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'create'));

CREATE POLICY mf_client_charges_update ON public.mf_client_charges
  FOR UPDATE TO authenticated
  USING (public.mf_can(business_id, branch_id, 'repayments', 'write'))
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'write'));

CREATE TRIGGER mf_client_charges_touch
  BEFORE UPDATE ON public.mf_client_charges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();