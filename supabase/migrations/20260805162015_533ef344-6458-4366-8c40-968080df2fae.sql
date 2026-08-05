-- 1. Repair existing duplicates before the constraint lands.
WITH ranked AS (
  SELECT id, product_id, kind, code_norm,
         row_number() OVER (
           PARTITION BY product_id, kind, code_norm
           ORDER BY (status = 'active') DESC, created_at DESC, id
         ) AS rn,
         first_value(id) OVER (
           PARTITION BY product_id, kind, code_norm
           ORDER BY (status = 'active') DESC, created_at DESC, id
         ) AS keep_id
  FROM public.product_identifiers
),
losers AS (SELECT id, keep_id FROM ranked WHERE rn > 1)
UPDATE public.product_identifiers pi
   SET replaced_by_id = l.keep_id
  FROM losers l
 WHERE pi.replaced_by_id = l.id;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY product_id, kind, code_norm
           ORDER BY (status = 'active') DESC, created_at DESC, id
         ) AS rn
  FROM public.product_identifiers
)
DELETE FROM public.product_identifiers
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. Structural guarantee: one row per product/kind/code across ALL statuses.
CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_product_kind_code_uidx
  ON public.product_identifiers (product_id, kind, code_norm);

-- 3. Idempotent, intent-respecting mirror.
CREATE OR REPLACE FUNCTION public.sync_product_identifiers_from_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_sku_changed boolean := (TG_OP = 'INSERT') OR (OLD.sku IS DISTINCT FROM NEW.sku);
  v_plu_changed boolean := (TG_OP = 'INSERT') OR (OLD.plu_code IS DISTINCT FROM NEW.plu_code);
  v_existing public.product_identifiers%ROWTYPE;
BEGIN
  ----------------------------------------------------------------- SKU mirror
  IF NEW.sku IS NOT NULL AND length(btrim(NEW.sku)) > 0 THEN
    SELECT * INTO v_existing
      FROM public.product_identifiers
     WHERE product_id = NEW.id
       AND kind = 'sku'
       AND code_norm = upper(btrim(NEW.sku));

    IF v_existing.id IS NOT NULL THEN
      -- Reconcile in place. Only revive a retired mirror when the SKU value
      -- itself was (re)assigned; an unrelated product save must never
      -- resurrect an identifier the operator deliberately retired.
      IF v_existing.status <> 'active' AND v_sku_changed THEN
        UPDATE public.product_identifiers
           SET status = 'active', valid_to = NULL, updated_at = now()
         WHERE id = v_existing.id;
      END IF;
    ELSE
      INSERT INTO public.product_identifiers
        (organization_id, business_id, product_id, code, kind, is_primary)
      VALUES (
        NEW.organization_id, NEW.business_id, NEW.id, btrim(NEW.sku), 'sku',
        NOT EXISTS (
          SELECT 1 FROM public.product_identifiers
           WHERE product_id = NEW.id AND is_primary
        )
      )
      ON CONFLICT (business_id, code_norm)
        WHERE status = 'active'::product_identifier_status AND supplier_id IS NULL
        DO NOTHING;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.sku IS DISTINCT FROM NEW.sku AND OLD.sku IS NOT NULL THEN
    UPDATE public.product_identifiers
       SET status = 'archived'::product_identifier_status,
           is_primary = false,
           valid_to = COALESCE(valid_to, now())
     WHERE product_id = NEW.id
       AND kind = 'sku'
       AND code_norm = upper(btrim(OLD.sku))
       AND status = 'active'::product_identifier_status
       AND (NEW.sku IS NULL OR upper(btrim(NEW.sku)) <> upper(btrim(OLD.sku)));
  END IF;

  ----------------------------------------------------------------- PLU mirror
  IF NEW.plu_code IS NOT NULL AND length(btrim(NEW.plu_code)) > 0 THEN
    SELECT * INTO v_existing
      FROM public.product_identifiers
     WHERE product_id = NEW.id
       AND kind = 'plu'
       AND code_norm = upper(btrim(NEW.plu_code));

    IF v_existing.id IS NOT NULL THEN
      IF v_existing.status <> 'active' AND v_plu_changed THEN
        UPDATE public.product_identifiers
           SET status = 'active', valid_to = NULL, updated_at = now()
         WHERE id = v_existing.id;
      END IF;
    ELSE
      INSERT INTO public.product_identifiers
        (organization_id, business_id, product_id, code, kind, is_primary)
      VALUES (NEW.organization_id, NEW.business_id, NEW.id, btrim(NEW.plu_code), 'plu', false)
      ON CONFLICT (business_id, code_norm)
        WHERE status = 'active'::product_identifier_status AND supplier_id IS NULL
        DO NOTHING;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.plu_code IS DISTINCT FROM NEW.plu_code AND OLD.plu_code IS NOT NULL THEN
    UPDATE public.product_identifiers
       SET status = 'archived'::product_identifier_status,
           is_primary = false,
           valid_to = COALESCE(valid_to, now())
     WHERE product_id = NEW.id
       AND kind = 'plu'
       AND code_norm = upper(btrim(OLD.plu_code))
       AND status = 'active'::product_identifier_status
       AND (NEW.plu_code IS NULL OR upper(btrim(NEW.plu_code)) <> upper(btrim(OLD.plu_code)));
  END IF;

  RETURN NEW;
END;
$fn$;