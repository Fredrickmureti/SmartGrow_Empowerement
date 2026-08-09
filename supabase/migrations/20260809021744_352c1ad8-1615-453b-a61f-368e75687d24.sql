-- =========================================================
-- Phase 2 — lifecycle columns become engine-owned
--
-- Every delivery engine (complete/cancel/dispatch/ready/partial/invoice/WMS
-- bridge) is SECURITY DEFINER owned by postgres, so it is unaffected by the
-- caller's privileges. Removing table-wide UPDATE from the API roles and
-- granting back only the descriptive columns makes it impossible for the
-- browser to flip `status` to 'delivered' — which previously fired the
-- completed/shipped event triggers with no stock movement, no cost snapshot
-- and no COGS journal. DELETE is removed for the same reason: removal must
-- go through cancel_delivery_atomic so movements and journals are reversed.
-- =========================================================
REVOKE UPDATE, DELETE ON public.delivery_notes FROM authenticated, anon;
REVOKE DELETE ON public.delivery_note_items FROM anon;

GRANT UPDATE (
  notes,
  delivery_date,
  shipping_address,
  driver_name,
  vehicle_number,
  contact_id,
  received_by_contact_id,
  auto_invoice_on_complete,
  updated_at
) ON public.delivery_notes TO authenticated;

GRANT ALL ON public.delivery_notes TO service_role;

-- =========================================================
-- Phase 3 — numbering: repair duplicates, then make it safe
-- =========================================================

-- Existing data carries duplicates produced by the MAX()+1 scan
-- (regexp_replace collapsed 'DN-2026-0001' to '20260001'). Renumber every
-- duplicate except the earliest row in each group. Only the display number
-- changes; ids, lineage, lines, movements and journals are untouched.
WITH ranked AS (
  SELECT id, organization_id, business_id, delivery_number,
         row_number() OVER (PARTITION BY organization_id, business_id, delivery_number
                            ORDER BY created_at, id) AS rn
  FROM public.delivery_notes
),
dupes AS (SELECT * FROM ranked WHERE rn > 1),
maxima AS (
  SELECT organization_id, business_id,
         COALESCE(MAX(NULLIF(regexp_replace(delivery_number, '^DN-\d{4}-', ''), '')::int), 0) AS max_seq
  FROM public.delivery_notes
  WHERE delivery_number ~ '^DN-\d{4}-\d+$'
  GROUP BY organization_id, business_id
),
assigned AS (
  SELECT d.id,
         'DN-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
         lpad((m.max_seq + row_number() OVER (PARTITION BY d.organization_id, d.business_id ORDER BY d.id))::text, 4, '0') AS new_number
  FROM dupes d
  JOIN maxima m ON m.organization_id = d.organization_id
               AND m.business_id IS NOT DISTINCT FROM d.business_id
)
UPDATE public.delivery_notes dn
SET delivery_number = a.new_number
FROM assigned a
WHERE dn.id = a.id;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_notes_number_unique
  ON public.delivery_notes (organization_id, business_id, delivery_number);

-- Business-scoped, lock-protected allocator. The legacy org-only signature is
-- kept for existing callers and now delegates to the safe implementation.
CREATE OR REPLACE FUNCTION public.get_next_delivery_number(_org_id uuid, _business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  year_prefix text := to_char(CURRENT_DATE, 'YYYY');
  next_num int;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('dn_number:' || _org_id::text || ':' || COALESCE(_business_id::text, '-'), 0)
  );

  SELECT COALESCE(MAX(NULLIF(regexp_replace(delivery_number, '^DN-\d{4}-', ''), '')::int), 0) + 1
    INTO next_num
  FROM public.delivery_notes
  WHERE organization_id = _org_id
    AND business_id IS NOT DISTINCT FROM _business_id
    AND delivery_number ~ ('^DN-' || year_prefix || '-\d+$');

  RETURN 'DN-' || year_prefix || '-' || lpad(next_num::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_delivery_number(_org_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_next_delivery_number(_org_id, NULL::uuid);
$$;

GRANT EXECUTE ON FUNCTION public.get_next_delivery_number(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_delivery_number(uuid) TO authenticated;

-- =========================================================
-- Phase 3 — atomic manual creation
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_delivery_note_atomic(
  p_payload jsonb,
  p_lines jsonb,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := (p_payload->>'organization_id')::uuid;
  v_biz uuid := (p_payload->>'business_id')::uuid;
  v_number text;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_biz IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required'
      USING ERRCODE = '22023';
  END IF;

  v_number := public.get_next_delivery_number(v_org, v_biz);

  INSERT INTO public.delivery_notes (
    organization_id, business_id, branch_id, delivery_number, contact_id,
    delivery_date, status, sales_order_id, shipping_address, driver_name,
    vehicle_number, notes, auto_invoice_on_complete, created_by
  ) VALUES (
    v_org, v_biz, NULLIF(p_payload->>'branch_id','')::uuid, v_number,
    NULLIF(p_payload->>'contact_id','')::uuid,
    COALESCE(NULLIF(p_payload->>'delivery_date','')::date, CURRENT_DATE),
    'pending',
    NULLIF(p_payload->>'sales_order_id','')::uuid,
    NULLIF(p_payload->>'shipping_address',''),
    NULLIF(p_payload->>'driver_name',''),
    NULLIF(p_payload->>'vehicle_number',''),
    NULLIF(p_payload->>'notes',''),
    COALESCE((p_payload->>'auto_invoice_on_complete')::boolean, true),
    p_user_id
  )
  RETURNING id INTO v_id;

  INSERT INTO public.delivery_note_items (
    delivery_note_id, description, quantity_ordered, quantity_delivered,
    product_id, sales_order_item_id, unit_price, tax_rate, tax_amount,
    discount_percent, line_total, sort_order, lot_number, serial_number,
    lot_allocations
  )
  SELECT
    v_id,
    COALESCE(l->>'description',''),
    COALESCE((l->>'quantity_ordered')::numeric, 0),
    COALESCE((l->>'quantity_delivered')::numeric, 0),
    NULLIF(l->>'product_id','')::uuid,
    NULLIF(l->>'sales_order_item_id','')::uuid,
    NULLIF(l->>'unit_price','')::numeric,
    NULLIF(l->>'tax_rate','')::numeric,
    NULLIF(l->>'tax_amount','')::numeric,
    COALESCE(NULLIF(l->>'discount_percent','')::numeric, 0),
    NULLIF(l->>'line_total','')::numeric,
    (ord - 1)::int,
    NULLIF(l->>'lot_number',''),
    NULLIF(l->>'serial_number',''),
    CASE WHEN l ? 'lot_allocations' THEN l->'lot_allocations' ELSE NULL END
  FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) WITH ORDINALITY AS t(l, ord);

  RETURN jsonb_build_object('success', true, 'id', v_id, 'delivery_number', v_number);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_delivery_note_atomic(jsonb, jsonb, uuid) TO authenticated;

-- =========================================================
-- Phase 4 — derived delivery line balances
-- =========================================================
CREATE OR REPLACE VIEW public.dn_line_balances
WITH (security_invoker = true) AS
SELECT
  dni.id                              AS delivery_note_item_id,
  dni.delivery_note_id,
  dn.organization_id,
  dn.business_id,
  dni.product_id,
  dni.quantity_ordered,
  CASE WHEN dn.status IN ('delivered','partial') THEN dni.quantity_delivered ELSE 0 END AS quantity_delivered,
  CASE WHEN dn.spawned_invoice_id IS NOT NULL AND dn.status IN ('delivered','partial')
       THEN dni.quantity_delivered ELSE 0 END AS quantity_invoiced,
  COALESCE(ret.qty_returned, 0)       AS quantity_returned,
  GREATEST(dni.quantity_ordered - dni.quantity_delivered, 0) AS quantity_outstanding
FROM public.delivery_note_items dni
JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
LEFT JOIN LATERAL (
  SELECT SUM(rdi.quantity_delivered) AS qty_returned
  FROM public.delivery_notes rdn
  JOIN public.delivery_note_items rdi ON rdi.delivery_note_id = rdn.id
  WHERE rdn.return_of_dn_id = dn.id
    AND rdn.is_return
    AND rdn.status IN ('delivered','partial')
    AND rdi.product_id IS NOT DISTINCT FROM dni.product_id
) ret ON true;

GRANT SELECT ON public.dn_line_balances TO authenticated;