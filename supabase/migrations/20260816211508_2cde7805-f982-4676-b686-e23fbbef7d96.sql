-- Phase 9: purchase-price override governance
CREATE TABLE IF NOT EXISTS public.purchase_price_override_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  tolerance_pct numeric NOT NULL DEFAULT 0,
  tolerance_abs numeric NOT NULL DEFAULT 0,
  require_reason boolean NOT NULL DEFAULT true,
  require_approval boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id)
);

COMMENT ON TABLE public.purchase_price_override_policies IS
  'Business configuration (ADR 0142 amendment): how far a purchase order line price may deviate above the price resolved by resolve_purchase_line_price before a reason, and optionally an approval, is required. No row for a business means overrides are not policed.';
COMMENT ON COLUMN public.purchase_price_override_policies.tolerance_pct IS 'Allowed upward deviation from the resolved price, in percent.';
COMMENT ON COLUMN public.purchase_price_override_policies.tolerance_abs IS 'Allowed upward deviation from the resolved price, in the line currency. The effective allowance is the greater of the two.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_price_override_policies TO authenticated;
GRANT ALL ON public.purchase_price_override_policies TO service_role;
ALTER TABLE public.purchase_price_override_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ppo tenant read" ON public.purchase_price_override_policies
  FOR SELECT TO authenticated USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "ppo tenant write" ON public.purchase_price_override_policies
  FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS resolved_unit_price numeric,
  ADD COLUMN IF NOT EXISTS price_override_reason text,
  ADD COLUMN IF NOT EXISTS price_override_approval_id uuid;

COMMENT ON COLUMN public.purchase_order_items.resolved_unit_price IS
  'The price public._resolve_purchase_line_price returned when the line was priced. Kept so a historical override can be explained without re-running the resolver.';
COMMENT ON COLUMN public.purchase_order_items.price_override_reason IS
  'Operator justification, required when the agreed price exceeds the resolved price beyond the business purchase price override policy.';
COMMENT ON COLUMN public.purchase_order_items.price_override_approval_id IS
  'approval_requests row raised for this override, when the org configured a rule for purchase_order.price_override.';

INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description, severity_default, is_active, requires_approval_always)
VALUES
  ('purchase_order.price_override', 'purchases', 'purchase_order_items', 'from_entity',
   'Purchase price override',
   'A purchase order line was priced above the price resolved from contracts and supplier conditions, beyond the configured tolerance.',
   'high', true, false)
ON CONFLICT (action_key) DO UPDATE
  SET is_active = true, subject_table = EXCLUDED.subject_table, label = EXCLUDED.label, description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION public._po_item_stamp_price_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_po RECORD;
  v_res jsonb;
  v_resolved numeric;
  v_policy public.purchase_price_override_policies;
  v_allowance numeric;
  v_over numeric;
  v_req uuid;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  SELECT po.business_id, po.vendor_id, po.branch_id, po.order_date
    INTO v_po FROM public.purchase_orders po WHERE po.id = NEW.purchase_order_id;
  IF v_po.business_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.price_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_res := public._resolve_purchase_line_price(
    v_po.business_id, NEW.product_id, v_po.vendor_id,
    NEW.quantity, COALESCE(v_po.order_date::date, CURRENT_DATE), v_po.branch_id);

  v_resolved := NULLIF(v_res->>'unit_price','')::numeric;
  NEW.resolved_unit_price := v_resolved;

  NEW.supplier_terms_id := COALESCE(NEW.supplier_terms_id,
                                    NULLIF(v_res->>'supplier_terms_id','')::uuid);
  NEW.contract_line_id  := COALESCE(NEW.contract_line_id,
                                    NULLIF(v_res->>'contract_line_id','')::uuid);
  NEW.contract_unit_price := COALESCE(NEW.contract_unit_price,
    CASE WHEN v_res->>'price_source' = 'contract' THEN v_resolved END);

  NEW.price_source :=
    CASE
      WHEN v_resolved IS NOT NULL
       AND NEW.unit_price IS NOT DISTINCT FROM v_resolved
      THEN v_res->>'price_source'
      ELSE 'manual'
    END;

  IF v_resolved IS NULL OR NEW.unit_price IS NULL OR NEW.unit_price <= v_resolved THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_policy
    FROM public.purchase_price_override_policies
   WHERE business_id = v_po.business_id AND is_active;

  IF v_policy.id IS NULL THEN
    RETURN NEW;
  END IF;

  v_allowance := GREATEST(COALESCE(v_policy.tolerance_abs, 0),
                          v_resolved * COALESCE(v_policy.tolerance_pct, 0) / 100.0);
  v_over := NEW.unit_price - v_resolved - v_allowance;

  IF v_over <= 0 THEN
    RETURN NEW;
  END IF;

  IF v_policy.require_reason
     AND COALESCE(btrim(NEW.price_override_reason), '') = '' THEN
    RAISE EXCEPTION 'PRICE_OVERRIDE_REASON_REQUIRED'
      USING DETAIL = format('resolved=%s agreed=%s allowance=%s', v_resolved, NEW.unit_price, v_allowance),
            HINT = 'Record why this line is priced above the resolved purchasing condition.';
  END IF;

  IF v_policy.require_approval THEN
    v_req := (public.approval_route(
      'purchase_order.price_override', 'purchase_order_items', NEW.id,
      NULL,
      jsonb_build_object('resolved_unit_price', v_resolved,
                         'agreed_unit_price', NEW.unit_price,
                         'allowance', v_allowance,
                         'product_id', NEW.product_id,
                         'purchase_order_id', NEW.purchase_order_id,
                         'reason', NEW.price_override_reason),
      jsonb_build_object('business_id', v_po.business_id, 'branch_id', v_po.branch_id),
      'purchase_order.price_override:' || NEW.id::text || ':' || NEW.unit_price::text,
      v_po.business_id
    )->>'approval_request_id')::uuid;
    NEW.price_override_approval_id := COALESCE(v_req, NEW.price_override_approval_id);
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public._po_item_stamp_price_provenance() FROM PUBLIC, anon;