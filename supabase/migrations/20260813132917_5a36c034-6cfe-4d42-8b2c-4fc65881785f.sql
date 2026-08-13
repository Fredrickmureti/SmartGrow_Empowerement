-- ============================================================
-- Landed Cost Reconstruction — Step 2: domain model
-- ============================================================

-- Keep bill-match wiring alive across the table swap.
ALTER TABLE public.bill_match_results
  DROP CONSTRAINT IF EXISTS bill_match_results_landed_cost_bill_id_fkey;

DROP FUNCTION IF EXISTS public.allocate_landed_cost_bill(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.post_landed_cost_bill(uuid);
DROP FUNCTION IF EXISTS public.reverse_landed_cost_bill(uuid, text);
DROP TABLE IF EXISTS public.landed_cost_allocations;
DROP TABLE IF EXISTS public.landed_cost_bills;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'landed_cost_voucher_status') THEN
    CREATE TYPE public.landed_cost_voucher_status AS ENUM (
      'draft', 'pending_approval', 'allocated', 'posted', 'reversed', 'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'landed_cost_allocation_basis') THEN
    CREATE TYPE public.landed_cost_allocation_basis AS ENUM (
      'value', 'quantity', 'weight', 'volume', 'manual'
    );
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Configurable cost component catalog
-- ------------------------------------------------------------
CREATE TABLE public.landed_cost_component_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  is_capitalizable boolean NOT NULL DEFAULT true,
  default_basis public.landed_cost_allocation_basis NOT NULL DEFAULT 'value',
  expense_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_component_types TO authenticated;
GRANT ALL ON public.landed_cost_component_types TO service_role;
ALTER TABLE public.landed_cost_component_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lc_component_types_read" ON public.landed_cost_component_types
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "lc_component_types_write" ON public.landed_cost_component_types
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE TRIGGER trg_lc_component_types_touch
  BEFORE UPDATE ON public.landed_cost_component_types
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- ------------------------------------------------------------
-- 2. Voucher header
-- ------------------------------------------------------------
CREATE TABLE public.landed_cost_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  voucher_number text NOT NULL,
  status public.landed_cost_voucher_status NOT NULL DEFAULT 'draft',
  voucher_date date NOT NULL DEFAULT CURRENT_DATE,
  posting_date date,
  shipment_reference text,
  vendor_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  source_bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  default_basis public.landed_cost_allocation_basis NOT NULL DEFAULT 'value',
  currency text NOT NULL DEFAULT 'KES',
  exchange_rate numeric(18,8) NOT NULL DEFAULT 1,
  exchange_rate_date date,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_base_amount numeric(18,2) NOT NULL DEFAULT 0,
  capitalized_amount numeric(18,2) NOT NULL DEFAULT 0,
  expensed_amount numeric(18,2) NOT NULL DEFAULT 0,
  notes text,
  approval_request_id uuid,
  allocated_at timestamptz,
  allocated_by uuid,
  posted_at timestamptz,
  posted_by uuid,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, voucher_number)
);

CREATE INDEX landed_cost_vouchers_business_status_idx
  ON public.landed_cost_vouchers(business_id, status, voucher_date DESC);
CREATE INDEX landed_cost_vouchers_vendor_idx ON public.landed_cost_vouchers(vendor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_vouchers TO authenticated;
GRANT ALL ON public.landed_cost_vouchers TO service_role;
ALTER TABLE public.landed_cost_vouchers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lc_vouchers_read" ON public.landed_cost_vouchers
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "lc_vouchers_insert" ON public.landed_cost_vouchers
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id) AND status = 'draft');
CREATE POLICY "lc_vouchers_update_open" ON public.landed_cost_vouchers
  FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id)
         AND status IN ('draft', 'pending_approval', 'allocated'))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id)
              AND status IN ('draft', 'pending_approval', 'allocated', 'cancelled'));
CREATE POLICY "lc_vouchers_delete_draft" ON public.landed_cost_vouchers
  FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id) AND status = 'draft');

CREATE TRIGGER trg_lc_vouchers_touch
  BEFORE UPDATE ON public.landed_cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

COMMENT ON TABLE public.landed_cost_vouchers IS
  'Landed cost voucher: accumulates acquisition charges and capitalises them onto received stock. Posting/reversal only via RPC.';

-- ------------------------------------------------------------
-- 3. Charge lines
-- ------------------------------------------------------------
CREATE TABLE public.landed_cost_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.landed_cost_vouchers(id) ON DELETE CASCADE,
  component_type_id uuid REFERENCES public.landed_cost_component_types(id) ON DELETE RESTRICT,
  description text,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  base_amount numeric(18,2) NOT NULL DEFAULT 0,
  basis public.landed_cost_allocation_basis NOT NULL DEFAULT 'value',
  is_capitalizable boolean NOT NULL DEFAULT true,
  expense_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  source_bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  source_bill_item_id uuid REFERENCES public.bill_items(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_components_amount_nonneg CHECK (amount >= 0)
);

CREATE INDEX landed_cost_components_voucher_idx ON public.landed_cost_components(voucher_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_components TO authenticated;
GRANT ALL ON public.landed_cost_components TO service_role;
ALTER TABLE public.landed_cost_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lc_components_read" ON public.landed_cost_components
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "lc_components_write" ON public.landed_cost_components
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')));

CREATE TRIGGER trg_lc_components_touch
  BEFORE UPDATE ON public.landed_cost_components
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- ------------------------------------------------------------
-- 4. Allocations (computed spread onto receipt lines)
-- ------------------------------------------------------------
CREATE TABLE public.landed_cost_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.landed_cost_vouchers(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES public.landed_cost_components(id) ON DELETE CASCADE,
  goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE RESTRICT,
  goods_receipt_item_id uuid NOT NULL REFERENCES public.goods_receipt_items(id) ON DELETE RESTRICT,
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  basis public.landed_cost_allocation_basis NOT NULL,
  basis_value numeric(18,6) NOT NULL DEFAULT 0,
  allocation_ratio numeric(18,10) NOT NULL DEFAULT 0,
  allocated_amount numeric(18,2) NOT NULL DEFAULT 0,
  capitalized_amount numeric(18,2) NOT NULL DEFAULT 0,
  expensed_amount numeric(18,2) NOT NULL DEFAULT 0,
  is_manual boolean NOT NULL DEFAULT false,
  revaluation_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_id, goods_receipt_item_id)
);

CREATE INDEX landed_cost_allocations_voucher_idx ON public.landed_cost_allocations(voucher_id);
CREATE INDEX landed_cost_allocations_gri_idx ON public.landed_cost_allocations(goods_receipt_item_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_allocations TO authenticated;
GRANT ALL ON public.landed_cost_allocations TO service_role;
ALTER TABLE public.landed_cost_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lc_allocations_read" ON public.landed_cost_allocations
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "lc_allocations_write" ON public.landed_cost_allocations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')));

CREATE TRIGGER trg_lc_allocations_touch
  BEFORE UPDATE ON public.landed_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- ------------------------------------------------------------
-- 5. Re-point bill matching at the voucher, and patch the matcher
-- ------------------------------------------------------------
ALTER TABLE public.bill_match_results
  ADD CONSTRAINT bill_match_results_landed_cost_bill_id_fkey
  FOREIGN KEY (landed_cost_bill_id)
  REFERENCES public.landed_cost_vouchers(id) ON DELETE SET NULL;

DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.match_bill_atomic(uuid,uuid,uuid)'::regprocedure);
  IF position('public.landed_cost_bills' IN v_def) = 0 THEN
    RAISE EXCEPTION 'match_bill_atomic no longer references landed_cost_bills — review manually';
  END IF;
  EXECUTE replace(v_def, 'public.landed_cost_bills', 'public.landed_cost_vouchers');
END $$;

-- ------------------------------------------------------------
-- 6. Voucher numbering
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._next_landed_cost_voucher_no(p_business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_seq integer;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(voucher_number, '^LCV-' || v_year || '-', ''), '')::integer), 0) + 1
    INTO v_seq
    FROM public.landed_cost_vouchers
   WHERE business_id = p_business_id
     AND voucher_number ~ ('^LCV-' || v_year || '-[0-9]+$');

  RETURN 'LCV-' || v_year || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public._landed_cost_vouchers_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.voucher_number IS NULL OR NEW.voucher_number = '' THEN
    NEW.voucher_number := public._next_landed_cost_voucher_no(NEW.business_id);
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.landed_cost_vouchers ALTER COLUMN voucher_number DROP NOT NULL;

CREATE TRIGGER trg_lc_vouchers_number
  BEFORE INSERT ON public.landed_cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_vouchers_assign_number();
