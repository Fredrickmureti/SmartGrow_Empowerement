ALTER TABLE public.budgets
  ADD COLUMN IF NOT EXISTS budget_code text,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.budgets.budget_code IS
  'Human-facing reference printed on the Budget Schedule. Unique per business, assigned on insert, immutable thereafter.';
COMMENT ON COLUMN public.budgets.approved_by IS
  'The user who moved this budget from draft to active. A budget in force is an approved instrument; this is the approval identity the document prints.';
COMMENT ON COLUMN public.budgets.approved_at IS
  'When the budget was activated. NULL for a draft.';

-- Backfill codes for existing rows: BUD-<fiscal year>-<nnn> within a business.
WITH numbered AS (
  SELECT id,
         business_id,
         fiscal_year,
         ROW_NUMBER() OVER (
           PARTITION BY business_id, fiscal_year ORDER BY created_at, id
         ) AS seq
  FROM public.budgets
  WHERE budget_code IS NULL
)
UPDATE public.budgets b
SET budget_code = 'BUD-' || n.fiscal_year::text || '-' || lpad(n.seq::text, 3, '0')
FROM numbered n
WHERE b.id = n.id;

-- A budget that is already in force was approved by someone; the only
-- defensible record we hold is its creator and creation time.
UPDATE public.budgets
SET approved_by = created_by,
    approved_at = created_at
WHERE status IN ('active', 'closed')
  AND approved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS budgets_business_code_key
  ON public.budgets (business_id, budget_code);