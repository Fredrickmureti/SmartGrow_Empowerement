
DO $$
DECLARE
  v_offender text;
BEGIN
  -- Safety belt: abort if any function body still references the soon-to-be-dropped columns.
  SELECT proname INTO v_offender
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND (
       prosrc ILIKE '%require_manager_pin_for_void%' OR
       prosrc ILIKE '%void_requires_manager_above_amount%' OR
       prosrc ILIKE '%require_manager_pin_for_return%' OR
       prosrc ILIKE '%return_requires_manager_above_amount%' OR
       prosrc ILIKE '%cash_out_requires_manager_above_amount%' OR
       prosrc ILIKE '%safe_drop_requires_manager_above_amount%' OR
       prosrc ILIKE '%bank_deposit_requires_manager_above_amount%' OR
       prosrc ILIKE '%require_manager_pin_for_discount%' OR
       prosrc ILIKE '%discount_limit_requires_approval%' OR
       prosrc ILIKE '%shift_variance_requires_manager_above_amount%'
     )
   LIMIT 1;
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 8.6 abort: function %() still references a dropped pos_security_settings column. Migrate it to assert_manager_override + pos_override_matrix first.', v_offender;
  END IF;
END$$;

-- Backfill matrix from current security-settings flag values, action-by-action,
-- only when no matrix row already exists for that (org, business, action).
WITH src AS (
  SELECT
    organization_id,
    business_id,
    require_manager_pin_for_void,
    void_requires_manager_above_amount,
    require_manager_pin_for_return,
    return_requires_manager_above_amount,
    require_manager_pin_for_discount,
    discount_limit_requires_approval,
    cash_out_requires_manager_above_amount,
    safe_drop_requires_manager_above_amount,
    bank_deposit_requires_manager_above_amount,
    shift_variance_requires_manager_above_amount
  FROM public.pos_security_settings
), expanded AS (
  SELECT organization_id, business_id, 'void_above_threshold'::text AS action,
         COALESCE(void_requires_manager_above_amount,0)::numeric AS threshold_amount,
         COALESCE(require_manager_pin_for_void,false) AS require_pin
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'refund',
         COALESCE(return_requires_manager_above_amount,0)::numeric,
         COALESCE(require_manager_pin_for_return,false)
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'discount_over_limit',
         COALESCE(discount_limit_requires_approval,0)::numeric,
         COALESCE(require_manager_pin_for_discount,false)
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'cash_out_above_threshold',
         COALESCE(cash_out_requires_manager_above_amount,0)::numeric,
         false
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'safe_drop',
         COALESCE(safe_drop_requires_manager_above_amount,0)::numeric,
         false
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'bank_deposit',
         COALESCE(bank_deposit_requires_manager_above_amount,0)::numeric,
         false
    FROM src
  UNION ALL
  SELECT organization_id, business_id, 'shift_variance',
         COALESCE(shift_variance_requires_manager_above_amount,0)::numeric,
         false
    FROM src
)
INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin, is_active, notes)
SELECT e.organization_id, e.business_id, e.action, e.threshold_amount, e.require_pin, true,
       'Auto-backfilled from pos_security_settings on Stage 8.6 retirement'
  FROM expanded e
 WHERE NOT EXISTS (
   SELECT 1 FROM public.pos_override_matrix m
    WHERE m.organization_id = e.organization_id
      AND m.action = e.action
      AND (m.business_id IS NULL OR m.business_id = e.business_id)
 );

-- Drop the redundant columns. The matrix is now authoritative.
ALTER TABLE public.pos_security_settings
  DROP COLUMN IF EXISTS require_manager_pin_for_void,
  DROP COLUMN IF EXISTS void_requires_manager_above_amount,
  DROP COLUMN IF EXISTS require_manager_pin_for_return,
  DROP COLUMN IF EXISTS return_requires_manager_above_amount,
  DROP COLUMN IF EXISTS cash_out_requires_manager_above_amount,
  DROP COLUMN IF EXISTS safe_drop_requires_manager_above_amount,
  DROP COLUMN IF EXISTS bank_deposit_requires_manager_above_amount,
  DROP COLUMN IF EXISTS require_manager_pin_for_discount,
  DROP COLUMN IF EXISTS discount_limit_requires_approval,
  DROP COLUMN IF EXISTS shift_variance_requires_manager_above_amount;
