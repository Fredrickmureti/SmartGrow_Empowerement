-- 1. Repair any invalid existing rows
UPDATE public.pos_payment_methods
   SET is_enabled = false
 WHERE is_enabled = true
   AND debit_account_id IS NULL;

-- 2. Drop the unconditional seeding trigger from businesses
DROP TRIGGER IF EXISTS trg_seed_pos_payment_methods ON public.businesses;
DROP FUNCTION IF EXISTS public.seed_pos_payment_methods_for_business() CASCADE;

-- 3. Create the new explicit POS seeder, called only on app install
CREATE OR REPLACE FUNCTION public.seed_pos_business_data(
  p_org_id uuid,
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Insert default POS payment methods as DISABLED (no GL yet)
  INSERT INTO public.pos_payment_methods (
    organization_id,
    business_id,
    method_key,
    name,
    is_enabled,
    debit_account_id,
    sort_order
  )
  VALUES
    (p_org_id, p_business_id, 'cash',          'Cash',          false, NULL, 1),
    (p_org_id, p_business_id, 'card',          'Card',          false, NULL, 2),
    (p_org_id, p_business_id, 'bank_transfer', 'Bank Transfer', false, NULL, 3),
    (p_org_id, p_business_id, 'mobile_money',  'Mobile Money',  false, NULL, 4)
  ON CONFLICT (business_id, method_key) DO NOTHING;

  -- Try to map GL accounts (Cash, Bank, etc.) — best-effort, won't fail
  BEGIN
    PERFORM public.pos_apply_default_method_gl(p_business_id);
  EXCEPTION WHEN OTHERS THEN
    -- Swallow: if GL mapping fails, methods stay disabled, user can fix in settings
    NULL;
  END;

  -- Enable only the methods that successfully resolved a debit_account_id
  UPDATE public.pos_payment_methods
     SET is_enabled = true
   WHERE business_id = p_business_id
     AND debit_account_id IS NOT NULL
     AND is_enabled = false;
END;
$$;

-- 4. Tighten uniqueness from (organization_id, method_key) to (business_id, method_key)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pos_payment_methods_organization_id_method_key_key'
  ) THEN
    ALTER TABLE public.pos_payment_methods
      DROP CONSTRAINT pos_payment_methods_organization_id_method_key_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pos_payment_methods_business_method_key'
  ) THEN
    ALTER TABLE public.pos_payment_methods
      ADD CONSTRAINT pos_payment_methods_business_method_key
      UNIQUE (business_id, method_key);
  END IF;
END $$;

-- 5. Patch seed_app_data to call the new POS seeder when the POS app is installed
CREATE OR REPLACE FUNCTION public.seed_app_data(
  p_org_id uuid,
  p_app_id text,
  p_business_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
BEGIN
  IF p_app_id = 'pos' THEN
    -- Resolve target business: explicit > default > first
    v_business_id := COALESCE(
      p_business_id,
      (SELECT id FROM public.businesses
        WHERE organization_id = p_org_id AND is_default = true
        LIMIT 1),
      (SELECT id FROM public.businesses
        WHERE organization_id = p_org_id
        ORDER BY created_at ASC
        LIMIT 1)
    );

    IF v_business_id IS NOT NULL THEN
      PERFORM public.seed_pos_business_data(p_org_id, v_business_id);
    END IF;
  END IF;

  -- Future: add other app branches here (inventory, hr, etc.)
END;
$$;

-- 6. Document the constraint for future maintainers
COMMENT ON CONSTRAINT pos_payment_methods_enabled_requires_account
  ON public.pos_payment_methods IS
  'A POS payment method may only be enabled once a debit_account_id (GL account) is mapped. Seeding inserts methods as disabled and only enables them after pos_apply_default_method_gl resolves the account.';