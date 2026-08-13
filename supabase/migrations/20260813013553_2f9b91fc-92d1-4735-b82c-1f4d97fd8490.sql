-- =====================================================================
-- Procurement Contracts: domain reconstruction (schema)
-- Phases 1-6 of the approved roadmap. All contract tables are empty,
-- so structural changes are applied directly without data migration.
-- =====================================================================

-- ---------- Phase 1: lifecycle state as a real enum ----------
DO $$ BEGIN
  CREATE TYPE public.procurement_contract_status AS ENUM
    ('draft','pending_approval','active','suspended','expired','terminated','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.procurement_contracts
  DROP CONSTRAINT IF EXISTS procurement_contracts_status_check;

ALTER TABLE public.procurement_contracts
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE public.procurement_contracts
  ALTER COLUMN status TYPE public.procurement_contract_status
  USING (CASE lower(status)
           WHEN 'draft' THEN 'draft'
           WHEN 'active' THEN 'active'
           WHEN 'expired' THEN 'expired'
           WHEN 'terminated' THEN 'terminated'
           WHEN 'superseded' THEN 'closed'
           ELSE 'draft' END)::public.procurement_contract_status;

ALTER TABLE public.procurement_contracts
  ALTER COLUMN status SET DEFAULT 'draft'::public.procurement_contract_status;

-- widen the kind vocabulary to the enterprise agreement taxonomy
ALTER TABLE public.procurement_contracts
  DROP CONSTRAINT IF EXISTS procurement_contracts_kind_check;
ALTER TABLE public.procurement_contracts
  ADD CONSTRAINT procurement_contracts_kind_check
  CHECK (kind = ANY (ARRAY['master','framework','blanket','rate','volume','service','consignment']));

-- ---------- Phase 2: canonical currency + FX ----------
ALTER TABLE public.procurement_contracts
  ADD COLUMN IF NOT EXISTS base_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8),
  ADD COLUMN IF NOT EXISTS exchange_rate_date date;

COMMENT ON COLUMN public.procurement_contracts.exchange_rate IS
  'Rate translating contract currency into the business base currency, stamped at activation. Contract currency remains authoritative for ceilings.';

DO $$ BEGIN
  ALTER TABLE public.procurement_contracts
    ADD CONSTRAINT procurement_contracts_currency_fkey
    FOREIGN KEY (currency) REFERENCES public.currencies(code) ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Phase 7 groundwork: negotiated price tolerance ----------
ALTER TABLE public.procurement_contracts
  ADD COLUMN IF NOT EXISTS price_tolerance_percent numeric(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_tolerance_amount numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enforce_item_coverage boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.procurement_contracts.enforce_item_coverage IS
  'When true, a PO citing this contract may only order products covered by a contract line.';

-- ---------- Phase 5: shared approval engine linkage ----------
ALTER TABLE public.procurement_contracts
  ADD COLUMN IF NOT EXISTS approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- ---------- Phase 6: distinct utilization measures ----------
ALTER TABLE public.procurement_contracts
  RENAME COLUMN utilized_value TO committed_value;
ALTER TABLE public.procurement_contracts
  ADD COLUMN IF NOT EXISTS received_value numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billed_value numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_value numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.procurement_contracts.committed_value IS
  'Value committed by approved purchase orders, net of reversals. Distinct from received/billed/paid.';

ALTER TABLE public.procurement_contract_lines
  RENAME COLUMN utilized_quantity TO committed_quantity;
ALTER TABLE public.procurement_contract_lines
  RENAME COLUMN utilized_value TO committed_value;

-- ---------- Phase 3: canonical UOM on contract lines ----------
ALTER TABLE public.procurement_contract_lines
  ADD COLUMN IF NOT EXISTS base_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS ceiling_quantity_base numeric(18,6),
  ADD COLUMN IF NOT EXISTS committed_quantity_base numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_quantity_base numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_value numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billed_value numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_sku text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date;

DO $$ BEGIN
  ALTER TABLE public.procurement_contract_lines
    ADD CONSTRAINT procurement_contract_lines_uom_fkey
    FOREIGN KEY (uom_id) REFERENCES public.units_of_measure(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.procurement_contract_lines.ceiling_quantity_base IS
  'Ceiling quantity normalised to the product base UoM via convert_uom(); the single quantity model shared with inventory.';

-- ---------- Phase 4: versions and effective-dated amendments ----------
CREATE TABLE IF NOT EXISTS public.procurement_contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.procurement_contracts(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  header_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, version_number)
);

GRANT SELECT ON public.procurement_contract_versions TO authenticated;
GRANT ALL ON public.procurement_contract_versions TO service_role;
ALTER TABLE public.procurement_contract_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY procurement_contract_versions_read
  ON public.procurement_contract_versions FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_pcv_contract ON public.procurement_contract_versions(contract_id, version_number DESC);

CREATE TABLE IF NOT EXISTS public.procurement_contract_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.procurement_contracts(id) ON DELETE CASCADE,
  from_version integer NOT NULL,
  to_version integer NOT NULL,
  amendment_number integer NOT NULL,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['extension','ceiling_change','price_change','scope_change','terms_change','renewal','other'])),
  effective_on date NOT NULL,
  reason text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, amendment_number)
);

GRANT SELECT ON public.procurement_contract_amendments TO authenticated;
GRANT ALL ON public.procurement_contract_amendments TO service_role;
ALTER TABLE public.procurement_contract_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY procurement_contract_amendments_read
  ON public.procurement_contract_amendments FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_pca_contract ON public.procurement_contract_amendments(contract_id, created_at DESC);

-- ---------- Phase 6: releases become a signed, append-only ledger ----------
ALTER TABLE public.procurement_contract_releases
  DROP CONSTRAINT IF EXISTS procurement_contract_releases_purchase_order_id_purchase_or_key;

ALTER TABLE public.procurement_contract_releases
  ALTER COLUMN purchase_order_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'commitment'
    CHECK (entry_kind = ANY (ARRAY['commitment','reversal','receipt','billing','payment'])),
  ADD COLUMN IF NOT EXISTS quantity_base numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_doc_type text,
  ADD COLUMN IF NOT EXISTS source_doc_id uuid,
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON TABLE public.procurement_contract_releases IS
  'Append-only contract consumption ledger. Signed entries: commitment (+), reversal (-), receipt/billing/payment stage markers. Header and line counters are derived from this ledger.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pcr_idempotency
  ON public.procurement_contract_releases(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcr_contract_kind
  ON public.procurement_contract_releases(contract_id, entry_kind);

-- ---------- Phase 9 groundwork: PO snapshot of contract terms ----------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS contract_snapshot jsonb;

COMMENT ON COLUMN public.purchase_orders.contract_snapshot IS
  'Immutable snapshot of contract terms (number, currency, FX rate, payment terms, incoterms, agreed prices) in force when the PO was approved.';

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS contract_unit_price numeric(18,4);

-- ---------- Phase 1: lock the write boundary ----------
DROP POLICY IF EXISTS procurement_contracts_write ON public.procurement_contracts;
DROP POLICY IF EXISTS procurement_contracts_read ON public.procurement_contracts;
DROP POLICY IF EXISTS procurement_contract_lines_write ON public.procurement_contract_lines;
DROP POLICY IF EXISTS procurement_contract_lines_read ON public.procurement_contract_lines;
DROP POLICY IF EXISTS procurement_contract_releases_write ON public.procurement_contract_releases;
DROP POLICY IF EXISTS procurement_contract_releases_read ON public.procurement_contract_releases;

CREATE POLICY procurement_contracts_read_v2
  ON public.procurement_contracts FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
  );

CREATE POLICY procurement_contract_lines_read_v2
  ON public.procurement_contract_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.procurement_contracts c
     WHERE c.id = procurement_contract_lines.contract_id
       AND public.user_can_access_business(auth.uid(), c.business_id)
       AND public.user_has_module_permission(auth.uid(), c.organization_id, c.business_id, 'purchases', 'read')
  ));

CREATE POLICY procurement_contract_releases_read_v2
  ON public.procurement_contract_releases FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.procurement_contracts c
     WHERE c.id = procurement_contract_releases.contract_id
       AND public.user_can_access_business(auth.uid(), c.business_id)
       AND public.user_has_module_permission(auth.uid(), c.organization_id, c.business_id, 'purchases', 'read')
  ));

-- No INSERT/UPDATE/DELETE policies: every mutation must go through the
-- SECURITY DEFINER contract RPCs. Revoke direct DML grants as defence in depth.
REVOKE INSERT, UPDATE, DELETE ON public.procurement_contracts FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.procurement_contract_lines FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.procurement_contract_releases FROM authenticated, anon;
GRANT SELECT ON public.procurement_contracts TO authenticated;
GRANT SELECT ON public.procurement_contract_lines TO authenticated;
GRANT SELECT ON public.procurement_contract_releases TO authenticated;
GRANT ALL ON public.procurement_contracts TO service_role;
GRANT ALL ON public.procurement_contract_lines TO service_role;
GRANT ALL ON public.procurement_contract_releases TO service_role;

-- ---------- Phase 10: register the event topic prefix ----------
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description)
SELECT 'procurement.contract.', 'procurement',
       ARRAY['procurement','finance','reporting']::text[],
       'Procurement contract lifecycle and utilization events'
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_event_topics WHERE topic_prefix = 'procurement.contract.'
);