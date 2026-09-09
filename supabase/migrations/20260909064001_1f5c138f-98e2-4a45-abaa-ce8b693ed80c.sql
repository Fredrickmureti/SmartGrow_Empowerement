CREATE TABLE public.mf_fee_collections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.mf_groups(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'admission_fee',
  collection_number text NOT NULL,
  collected_on date NOT NULL DEFAULT CURRENT_DATE,
  collected_by uuid,
  total_amount numeric(18,2) NOT NULL,
  currency_code text NOT NULL,
  method text NOT NULL DEFAULT 'cash',
  reference text,
  notes text,
  status text NOT NULL DEFAULT 'posted',
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  client_request_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_fee_collections_total_positive CHECK (total_amount > 0),
  CONSTRAINT mf_fee_collections_status_known CHECK (status IN ('posted','reversed')),
  CONSTRAINT mf_fee_collections_kind_known CHECK (kind IN ('admission_fee')),
  CONSTRAINT mf_fee_collections_number_uniq UNIQUE (business_id, collection_number)
);

COMMENT ON TABLE public.mf_fee_collections IS
  'One collective hand-over of client admission fees at a group meeting. The group is only the collection context; each settled amount stays attributed to an individual client through mf_client_charge_payments.';

CREATE UNIQUE INDEX mf_fee_collections_request_uniq
  ON public.mf_fee_collections (business_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX mf_fee_collections_group_idx
  ON public.mf_fee_collections (group_id, collected_on DESC);

ALTER TABLE public.mf_client_charge_payments
  ADD CONSTRAINT mf_ccp_collection_fk
  FOREIGN KEY (collection_id) REFERENCES public.mf_fee_collections(id) ON DELETE RESTRICT;

GRANT SELECT, INSERT, UPDATE ON public.mf_fee_collections TO authenticated;
GRANT ALL ON public.mf_fee_collections TO service_role;

ALTER TABLE public.mf_fee_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_fee_collections_read ON public.mf_fee_collections
  FOR SELECT TO authenticated
  USING (public.mf_can(business_id, branch_id, 'clients', 'read'));

CREATE POLICY mf_fee_collections_insert ON public.mf_fee_collections
  FOR INSERT TO authenticated
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'create'));

CREATE POLICY mf_fee_collections_update ON public.mf_fee_collections
  FOR UPDATE TO authenticated
  USING (public.mf_can(business_id, branch_id, 'repayments', 'write'))
  WITH CHECK (public.mf_can(business_id, branch_id, 'repayments', 'write'));

CREATE TRIGGER mf_fee_collections_touch
  BEFORE UPDATE ON public.mf_fee_collections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger routine is never called directly by clients.
REVOKE ALL ON FUNCTION public.mf_client_charge_recompute() FROM PUBLIC, anon, authenticated;