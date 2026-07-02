-- POS Stage J: cash-movement reason presets + denomination quick-count
ALTER TABLE public.pos_cash_movement_types
  ADD COLUMN IF NOT EXISTS reason_presets text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS quick_count_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pos_cash_movement_types.reason_presets IS
  'Tap-to-fill reason chips shown in the cash-drawer dialog. Empty array = free-text only.';
COMMENT ON COLUMN public.pos_cash_movement_types.quick_count_enabled IS
  'When true, the cash-drawer dialog shows a denomination counter and the amount is computed from tap counts.';

-- Seed defaults for the canonical types where empty.
UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Opening float','Float adjustment','Other'],
       quick_count_enabled = true
 WHERE movement_type = 'opening_float' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Float top-up','Manager top-up','Returned change','Other']
 WHERE movement_type = 'cash_in' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Petty cash','Supplier cash','Refund cash','Staff advance','Other']
 WHERE movement_type = 'cash_out' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Mid-shift pickup','End-of-shift pickup','Safe drop','Other'],
       quick_count_enabled = true
 WHERE movement_type = 'pickup' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Safe drop','Mid-shift safe drop','Other'],
       quick_count_enabled = true
 WHERE movement_type = 'safe_drop' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Daily deposit','Weekly deposit','Other'],
       quick_count_enabled = true
 WHERE movement_type = 'bank_deposit' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Office supplies','Cleaning','Tea/coffee','Repairs','Other']
 WHERE movement_type = 'petty_cash_out' AND coalesce(array_length(reason_presets,1),0) = 0;

UPDATE public.pos_cash_movement_types
   SET reason_presets = ARRAY['Counting correction','Manager adjustment','Other']
 WHERE movement_type = 'correction' AND coalesce(array_length(reason_presets,1),0) = 0;

-- Seed function (idempotent for new businesses) — augment the existing seeder
-- so newly-created businesses inherit the same defaults.
CREATE OR REPLACE FUNCTION public.seed_pos_cash_movement_type_defaults(
  p_business_id uuid,
  p_organization_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.pos_cash_movement_types
    (organization_id, business_id, movement_type, label, requires_reason,
     requires_manager_default, sort_order, reason_presets, quick_count_enabled)
  VALUES
    (p_organization_id, p_business_id, 'opening_float',  'Opening Float',   false, false, 1,
       ARRAY['Opening float','Float adjustment','Other'], true),
    (p_organization_id, p_business_id, 'cash_in',        'Cash In',         false, false, 2,
       ARRAY['Float top-up','Manager top-up','Returned change','Other'], false),
    (p_organization_id, p_business_id, 'cash_out',       'Cash Out',        true,  true,  3,
       ARRAY['Petty cash','Supplier cash','Refund cash','Staff advance','Other'], false),
    (p_organization_id, p_business_id, 'pickup',         'Cash Pickup',     true,  true,  4,
       ARRAY['Mid-shift pickup','End-of-shift pickup','Safe drop','Other'], true),
    (p_organization_id, p_business_id, 'safe_drop',      'Safe Drop',       true,  true,  5,
       ARRAY['Safe drop','Mid-shift safe drop','Other'], true),
    (p_organization_id, p_business_id, 'bank_deposit',   'Bank Deposit',    true,  true,  6,
       ARRAY['Daily deposit','Weekly deposit','Other'], true),
    (p_organization_id, p_business_id, 'petty_cash_out', 'Petty Cash',      true,  false, 7,
       ARRAY['Office supplies','Cleaning','Tea/coffee','Repairs','Other'], false),
    (p_organization_id, p_business_id, 'correction',     'Correction',      true,  true,  8,
       ARRAY['Counting correction','Manager adjustment','Other'], false)
  ON CONFLICT (business_id, movement_type) DO NOTHING;
END;
$$;
