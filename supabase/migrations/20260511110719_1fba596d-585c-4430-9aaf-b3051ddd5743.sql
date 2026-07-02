-- Stage L1 — drawer kick toggles for non-sale contexts
ALTER TABLE public.pos_registers
  ADD COLUMN IF NOT EXISTS drawer_kick_on_return  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drawer_kick_on_void    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drawer_kick_on_reprint boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pos_registers.drawer_kick_on_return  IS
  'L1: fire the drawer when a cash refund is processed. Card/mobile refunds still skip.';
COMMENT ON COLUMN public.pos_registers.drawer_kick_on_void    IS
  'L1: fire the drawer when a cash sale is voided. Card/mobile voids still skip.';
COMMENT ON COLUMN public.pos_registers.drawer_kick_on_reprint IS
  'L1: fire the drawer on receipt reprint. Default off.';

-- Stage L2 — cash-movement type thresholds + quick amounts
ALTER TABLE public.pos_cash_movement_types
  ADD COLUMN IF NOT EXISTS reason_required_above    numeric(14,2),
  ADD COLUMN IF NOT EXISTS manager_required_above   numeric(14,2),
  ADD COLUMN IF NOT EXISTS default_reason_preset_id uuid,
  ADD COLUMN IF NOT EXISTS quick_amounts numeric(14,2)[] NOT NULL DEFAULT ARRAY[]::numeric(14,2)[];

COMMENT ON COLUMN public.pos_cash_movement_types.reason_required_above IS
  'L2: amount above which the cashier must type a reason. NULL = always required (legacy).';
COMMENT ON COLUMN public.pos_cash_movement_types.manager_required_above IS
  'L2: amount above which a manager override is required (overrides security-settings threshold when set).';
COMMENT ON COLUMN public.pos_cash_movement_types.default_reason_preset_id IS
  'L2: preset id substituted when amount is below reason_required_above.';
COMMENT ON COLUMN public.pos_cash_movement_types.quick_amounts IS
  'L2: one-tap chips shown next to the amount input.';

UPDATE public.pos_cash_movement_types
   SET quick_amounts = CASE movement_type
         WHEN 'cash_in'       THEN ARRAY[20,50,100,200,500]::numeric(14,2)[]
         WHEN 'cash_out'      THEN ARRAY[20,50,100,200,500]::numeric(14,2)[]
         WHEN 'opening_float' THEN ARRAY[50,100,200,500]::numeric(14,2)[]
         WHEN 'pickup'        THEN ARRAY[100,200,500,1000]::numeric(14,2)[]
         WHEN 'safe_drop'     THEN ARRAY[100,200,500,1000]::numeric(14,2)[]
         WHEN 'bank_deposit'  THEN ARRAY[500,1000,2000,5000]::numeric(14,2)[]
         WHEN 'petty_cash_out' THEN ARRAY[10,20,50,100]::numeric(14,2)[]
         ELSE quick_amounts
       END,
       reason_required_above = COALESCE(reason_required_above, CASE movement_type
         WHEN 'cash_in'        THEN 100
         WHEN 'cash_out'       THEN 50
         WHEN 'opening_float'  THEN 200
         WHEN 'pickup'         THEN 0
         WHEN 'safe_drop'      THEN 0
         WHEN 'bank_deposit'   THEN 0
         WHEN 'petty_cash_out' THEN 0
         WHEN 'correction'     THEN 0
         ELSE NULL
       END)
 WHERE movement_type IN
   ('cash_in','cash_out','opening_float','pickup','safe_drop','bank_deposit','petty_cash_out','correction');
