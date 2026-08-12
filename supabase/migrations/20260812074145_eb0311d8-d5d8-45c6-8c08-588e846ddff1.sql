-- ---------------------------------------------------------------- lineage
ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS source_return_id uuid REFERENCES public.purchase_returns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS goods_receipt_id uuid,
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid,
  ADD COLUMN IF NOT EXISTS vendor_document_number text,
  ADD COLUMN IF NOT EXISTS vendor_document_date date,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'adjustment',
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS exchange_rate_date date,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_credit_notes_origin_chk') THEN
    ALTER TABLE public.vendor_credit_notes
      ADD CONSTRAINT vendor_credit_notes_origin_chk CHECK (origin IN (
        'purchase_return','overbilling','price_correction','quantity_discrepancy',
        'damaged_goods','rejected_goods','tax_correction','rebate',
        'supplier_credit','adjustment'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vendor_credit_notes_source_return_idx
  ON public.vendor_credit_notes (source_return_id) WHERE source_return_id IS NOT NULL;

-- ------------------------------------------------------------- provenance
ALTER TABLE public.vendor_credit_note_items
  ADD COLUMN IF NOT EXISTS bill_item_id uuid REFERENCES public.bill_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_unit_price numeric,
  ADD COLUMN IF NOT EXISTS source_tax_rate numeric;

CREATE INDEX IF NOT EXISTS vendor_credit_note_items_bill_item_idx
  ON public.vendor_credit_note_items (bill_item_id) WHERE bill_item_id IS NOT NULL;

-- --------------------------------------------------- creditable read model
CREATE OR REPLACE VIEW public.v_bill_creditable_qty
WITH (security_invoker = true) AS
SELECT bi.id                          AS bill_item_id,
       bi.bill_id,
       b.business_id,
       b.organization_id,
       bi.product_id,
       bi.description,
       bi.quantity                    AS billed_qty,
       bi.unit_price,
       bi.tax_rate,
       COALESCE(c.credited_qty, 0)    AS credited_qty,
       GREATEST(bi.quantity - COALESCE(c.credited_qty, 0), 0) AS remaining_qty,
       GREATEST(bi.quantity - COALESCE(c.credited_qty, 0), 0) * bi.unit_price AS remaining_net_amount
  FROM public.bill_items bi
  JOIN public.bills b ON b.id = bi.bill_id
  LEFT JOIN (
      SELECT vi.bill_item_id, SUM(vi.quantity) AS credited_qty
        FROM public.vendor_credit_note_items vi
        JOIN public.vendor_credit_notes vcn ON vcn.id = vi.credit_note_id
       WHERE vi.bill_item_id IS NOT NULL
         AND vcn.status <> 'void'
       GROUP BY vi.bill_item_id
  ) c ON c.bill_item_id = bi.id;

GRANT SELECT ON public.v_bill_creditable_qty TO authenticated;

-- --------------------------------------------- server-side line resolution
CREATE OR REPLACE FUNCTION public._resolve_vendor_credit_note_line(
  _line jsonb,
  _bill_id uuid,
  _exclude_vcn_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bi public.bill_items%ROWTYPE;
  v_qty numeric := COALESCE((_line->>'quantity')::numeric, 1);
  v_unit numeric;
  v_net numeric;
  v_tax numeric;
  v_already numeric := 0;
BEGIN
  IF NULLIF(_line->>'bill_item_id','') IS NULL THEN
    -- Off-bill credit: still recomputed server-side, never negative.
    v_unit := COALESCE((_line->>'unit_price')::numeric, 0);
    IF v_unit < 0 OR v_qty < 0 THEN
      RAISE EXCEPTION 'negative quantity or price on a vendor credit note line' USING ERRCODE='22023';
    END IF;
    v_net := ROUND(v_qty * v_unit, 2);
    v_tax := ROUND(COALESCE((_line->>'tax_amount')::numeric,
                            v_net * COALESCE((_line->>'tax_rate')::numeric, 0) / 100), 2);
    RETURN _line
      || jsonb_build_object('quantity', v_qty, 'unit_price', v_unit,
                            'line_total', v_net, 'tax_amount', v_tax,
                            'bill_item_id', NULL);
  END IF;

  SELECT * INTO v_bi FROM public.bill_items WHERE id = (_line->>'bill_item_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill line % not found', _line->>'bill_item_id' USING ERRCODE='P0002';
  END IF;
  IF _bill_id IS NOT NULL AND v_bi.bill_id <> _bill_id THEN
    RAISE EXCEPTION 'bill line % belongs to a different bill', v_bi.id USING ERRCODE='42501';
  END IF;

  -- Credit ceiling: never credit more than was billed on that line.
  SELECT COALESCE(SUM(vi.quantity), 0) INTO v_already
    FROM public.vendor_credit_note_items vi
    JOIN public.vendor_credit_notes vcn ON vcn.id = vi.credit_note_id
   WHERE vi.bill_item_id = v_bi.id
     AND vcn.status <> 'void'
     AND (_exclude_vcn_id IS NULL OR vcn.id <> _exclude_vcn_id);

  IF v_qty < 0 THEN
    RAISE EXCEPTION 'negative credit quantity on bill line %', v_bi.id USING ERRCODE='22023';
  END IF;
  IF v_already + v_qty > COALESCE(v_bi.quantity, 0) + 0.0005 THEN
    RAISE EXCEPTION 'credit ceiling exceeded on bill line %: billed %, already credited %, requested %',
      v_bi.id, v_bi.quantity, v_already, v_qty USING ERRCODE='22023';
  END IF;

  v_unit := COALESCE(v_bi.unit_price, 0);
  v_net  := ROUND(v_qty * v_unit, 2);
  v_tax  := CASE
              WHEN COALESCE(v_bi.quantity, 0) > 0 AND COALESCE(v_bi.tax_amount, 0) <> 0
                THEN ROUND(COALESCE(v_bi.tax_amount, 0) * (v_qty / v_bi.quantity), 2)
              ELSE ROUND(v_net * COALESCE(v_bi.tax_rate, 0) / 100, 2)
            END;

  RETURN _line || jsonb_build_object(
    'description', COALESCE(NULLIF(_line->>'description',''), v_bi.description),
    'product_id', COALESCE(NULLIF(_line->>'product_id','')::uuid, v_bi.product_id),
    'account_id', COALESCE(NULLIF(_line->>'account_id','')::uuid, v_bi.account_id),
    'quantity', v_qty,
    'unit_price', v_unit,
    'tax_rate', COALESCE(v_bi.tax_rate, 0),
    'tax_amount', v_tax,
    'line_total', v_net,
    'source_unit_price', v_bi.unit_price,
    'source_tax_rate', v_bi.tax_rate,
    'bill_item_id', v_bi.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public._resolve_vendor_credit_note_lines(
  _items jsonb, _bill_id uuid, _exclude_vcn_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(public._resolve_vendor_credit_note_line(i, _bill_id, _exclude_vcn_id)
                            || jsonb_build_object('sort_order', COALESCE((i->>'sort_order')::int, ord::int - 1))
                            ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(_items) WITH ORDINALITY AS t(i, ord);
$fn$;

GRANT EXECUTE ON FUNCTION public._resolve_vendor_credit_note_line(jsonb, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._resolve_vendor_credit_note_lines(jsonb, uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';