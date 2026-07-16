
-- Phase A.1 — Downstream lot/serial stamping (schema + recall view)
-- ADR 0066. Additive only; no writer changes.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

ALTER TABLE public.sales_return_items
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

ALTER TABLE public.credit_note_items
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text;

CREATE INDEX IF NOT EXISTS idx_invoice_items_lot_number ON public.invoice_items(lot_number)     WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_serial     ON public.invoice_items(serial_number)  WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_so_items_lot_number      ON public.sales_order_items(lot_number) WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_so_items_serial          ON public.sales_order_items(serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sr_items_lot_number      ON public.sales_return_items(lot_number) WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sr_items_serial          ON public.sales_return_items(serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cn_items_lot_number      ON public.credit_note_items(lot_number)  WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cn_items_serial          ON public.credit_note_items(serial_number) WHERE serial_number IS NOT NULL;

-- Canonical two-way recall view.
CREATE OR REPLACE VIEW public.v_lot_downstream_consumption AS
  -- POS sales
  SELECT
    'pos_transaction_items'::text                 AS source_table,
    pti.transaction_id                            AS document_id,
    'pos_transaction'::text                       AS document_type,
    pt.transaction_number                         AS document_number,
    pt.completed_at                               AS occurred_at,
    pti.product_id,
    pti.lot_number,
    pti.serial_number,
    pti.quantity,
    pt.customer_id                                AS contact_id,
    pt.cashier_id                                 AS counterparty_user_id,
    pt.business_id,
    pt.organization_id
  FROM public.pos_transaction_items pti
  JOIN public.pos_transactions pt ON pt.id = pti.transaction_id
  WHERE pti.lot_number IS NOT NULL OR pti.serial_number IS NOT NULL

  UNION ALL

  -- Delivery notes
  SELECT
    'delivery_note_items'::text,
    dni.delivery_note_id,
    'delivery_note'::text,
    dn.delivery_number,
    dn.delivery_date::timestamptz,
    dni.product_id,
    dni.lot_number,
    dni.serial_number,
    dni.quantity_delivered                        AS quantity,
    dn.contact_id,
    NULL::uuid,
    dn.business_id,
    dn.organization_id
  FROM public.delivery_note_items dni
  JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
  WHERE dni.lot_number IS NOT NULL OR dni.serial_number IS NOT NULL

  UNION ALL

  -- Invoices
  SELECT
    'invoice_items'::text,
    ii.invoice_id,
    'invoice'::text,
    inv.invoice_number,
    inv.issue_date::timestamptz,
    ii.product_id,
    ii.lot_number,
    ii.serial_number,
    ii.quantity,
    inv.contact_id,
    NULL::uuid,
    inv.business_id,
    inv.organization_id
  FROM public.invoice_items ii
  JOIN public.invoices inv ON inv.id = ii.invoice_id
  WHERE ii.lot_number IS NOT NULL OR ii.serial_number IS NOT NULL

  UNION ALL

  -- Sales returns
  SELECT
    'sales_return_items'::text,
    sri.sales_return_id,
    'sales_return'::text,
    sr.return_number,
    sr.return_date::timestamptz,
    sri.product_id,
    sri.lot_number,
    sri.serial_number,
    sri.quantity,
    sr.contact_id,
    NULL::uuid,
    sr.business_id,
    sr.organization_id
  FROM public.sales_return_items sri
  JOIN public.sales_returns sr ON sr.id = sri.sales_return_id
  WHERE sri.lot_number IS NOT NULL OR sri.serial_number IS NOT NULL

  UNION ALL

  -- Credit notes
  SELECT
    'credit_note_items'::text,
    cni.credit_note_id,
    'credit_note'::text,
    cn.credit_note_number,
    cn.issue_date::timestamptz,
    cni.product_id,
    cni.lot_number,
    cni.serial_number,
    cni.quantity,
    cn.contact_id,
    NULL::uuid,
    cn.business_id,
    cn.organization_id
  FROM public.credit_note_items cni
  JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
  WHERE cni.lot_number IS NOT NULL OR cni.serial_number IS NOT NULL;

GRANT SELECT ON public.v_lot_downstream_consumption TO authenticated;
GRANT SELECT ON public.v_lot_downstream_consumption TO service_role;

COMMENT ON VIEW public.v_lot_downstream_consumption IS
  'ADR 0066. Two-way recall — every downstream document line that consumed a given lot/serial. RLS on underlying base tables scopes rows to the caller''s tenant.';
