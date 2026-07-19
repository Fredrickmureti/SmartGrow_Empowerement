
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS use_holding_accounts boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.use_holding_accounts IS
  'S4: when true, POS GL posting resolves tender debit accounts through the holding-account map instead of pos_payment_methods.debit_account_id.';

INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('cash_in_drawer',        'Cash in Drawer',           'POS cash held at the register between shift open and bank deposit.',                                  'asset',     false, 'payment_method', 100),
  ('merchant_card_clearing','Merchant Card Clearing',   'Card sales pending settlement from the acquirer.',                                                    'asset',     false, 'payment_method', 110),
  ('mobile_money_clearing', 'Mobile Money Clearing',    'Wallet sales pending payout confirmation. Per-provider mapping in pos_tender_holding_account_map.',  'asset',     false, 'payment_method', 120),
  ('tip_liability',         'Tip Liability',            'Tips owed to staff, held as a liability until payroll disbursement.',                                 'liability', false, 'payment_method', 130)
ON CONFLICT (role_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pos_tender_holding_account_map (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id      uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  tender_kind    text NOT NULL,
  provider_key   text,
  role_key       text NOT NULL REFERENCES public.system_account_roles(role_key),
  account_id     uuid NOT NULL REFERENCES public.accounts(id),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT pos_tender_holding_account_map_kind_chk
    CHECK (tender_kind IN ('cash','card','wallet','bank','voucher','credit_liability','other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_tender_holding_map_uq
  ON public.pos_tender_holding_account_map (
    business_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    tender_kind,
    COALESCE(provider_key, ''),
    role_key
  ) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_tender_holding_account_map TO authenticated;
GRANT ALL ON public.pos_tender_holding_account_map TO service_role;

ALTER TABLE public.pos_tender_holding_account_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_tender_holding_map_read"
  ON public.pos_tender_holding_account_map FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "pos_tender_holding_map_write"
  ON public.pos_tender_holding_account_map FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id) AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id) AND public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_pos_tender_holding_map_updated_at
  BEFORE UPDATE ON public.pos_tender_holding_account_map
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.pos_tender_holding_account_map IS
  'S4: authoritative tender→holding-account mapping used when businesses.use_holding_accounts=true.';

CREATE OR REPLACE FUNCTION public.resolve_pos_tender_gl_account(
  p_business_id       uuid,
  p_branch_id         uuid,
  p_tender_kind       text,
  p_provider_key      text,
  p_payment_method_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag      boolean;
  v_role_key  text;
  v_account   uuid;
  v_fallback  uuid;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'resolve_pos_tender_gl_account: business_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT use_holding_accounts INTO v_flag FROM public.businesses WHERE id = p_business_id;
  SELECT debit_account_id     INTO v_fallback FROM public.pos_payment_methods WHERE id = p_payment_method_id;

  IF v_flag IS DISTINCT FROM true THEN
    RETURN v_fallback;
  END IF;

  v_role_key := CASE p_tender_kind
    WHEN 'cash'   THEN 'cash_in_drawer'
    WHEN 'card'   THEN 'merchant_card_clearing'
    WHEN 'wallet' THEN 'mobile_money_clearing'
    ELSE NULL
  END;

  IF v_role_key IS NULL THEN
    RETURN v_fallback;
  END IF;

  SELECT account_id INTO v_account
    FROM public.pos_tender_holding_account_map
   WHERE business_id = p_business_id
     AND is_active
     AND tender_kind = p_tender_kind
     AND role_key    = v_role_key
     AND (
       (branch_id = p_branch_id AND provider_key IS NOT DISTINCT FROM p_provider_key)
    OR (branch_id = p_branch_id AND provider_key IS NULL)
    OR (branch_id IS NULL       AND provider_key IS NOT DISTINCT FROM p_provider_key)
    OR (branch_id IS NULL       AND provider_key IS NULL)
     )
   ORDER BY (branch_id IS NOT NULL) DESC, (provider_key IS NOT NULL) DESC
   LIMIT 1;

  IF v_account IS NOT NULL THEN RETURN v_account; END IF;

  SELECT da.account_id INTO v_account
    FROM public.default_accounts da
   WHERE da.business_id = p_business_id
     AND da.purpose = v_role_key
   ORDER BY (da.branch_id = p_branch_id) DESC NULLS LAST
   LIMIT 1;

  IF v_account IS NOT NULL THEN RETURN v_account; END IF;

  RETURN v_fallback;
END;
$$;

COMMENT ON FUNCTION public.resolve_pos_tender_gl_account IS
  'S4: single source of truth for POS tender → GL account. Respects businesses.use_holding_accounts. Falls back to legacy pos_payment_methods.debit_account_id when off.';

REVOKE ALL ON FUNCTION public.resolve_pos_tender_gl_account(uuid,uuid,text,text,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_pos_tender_gl_account(uuid,uuid,text,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_pos_holding_account_readiness AS
WITH tenders_in_use AS (
  SELECT DISTINCT
    pm.business_id,
    pm.tender_kind,
    CASE pm.tender_kind
      WHEN 'cash'   THEN 'cash_in_drawer'
      WHEN 'card'   THEN 'merchant_card_clearing'
      WHEN 'wallet' THEN 'mobile_money_clearing'
    END AS role_key
  FROM public.pos_payment_methods pm
  WHERE pm.is_enabled AND pm.tender_kind IN ('cash','card','wallet')
),
mapped AS (
  SELECT DISTINCT business_id, role_key FROM public.pos_tender_holding_account_map WHERE is_active
  UNION
  SELECT DISTINCT business_id, purpose AS role_key FROM public.default_accounts
  WHERE purpose IN ('cash_in_drawer','merchant_card_clearing','mobile_money_clearing')
)
SELECT
  b.id AS business_id,
  b.name AS business_name,
  b.use_holding_accounts AS flag_enabled,
  COUNT(t.role_key) AS required_role_count,
  COUNT(m.role_key) AS mapped_role_count,
  ARRAY_AGG(t.role_key ORDER BY t.role_key) FILTER (WHERE m.role_key IS NULL) AS missing_roles,
  (COUNT(t.role_key) FILTER (WHERE m.role_key IS NULL) = 0) AS is_ready
FROM public.businesses b
LEFT JOIN tenders_in_use t ON t.business_id = b.id
LEFT JOIN mapped m ON m.business_id = b.id AND m.role_key = t.role_key
GROUP BY b.id, b.name, b.use_holding_accounts;

COMMENT ON VIEW public.v_pos_holding_account_readiness IS
  'S4: readiness check. is_ready=true means every enabled tender has a holding-account mapping.';

GRANT SELECT ON public.v_pos_holding_account_readiness TO authenticated, service_role;
