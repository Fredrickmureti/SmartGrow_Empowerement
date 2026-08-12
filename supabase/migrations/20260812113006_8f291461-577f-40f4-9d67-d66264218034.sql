-- 1. Dispute outcome is currently accepted by the resolver and thrown away.
ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS dispute_resolution text;

ALTER TABLE public.vendor_credit_notes
  DROP CONSTRAINT IF EXISTS vcn_dispute_resolution_chk;
ALTER TABLE public.vendor_credit_notes
  ADD CONSTRAINT vcn_dispute_resolution_chk
  CHECK (dispute_resolution IS NULL OR dispute_resolution IN ('accepted','withdrawn'));

-- 2. Lineage columns had no referential integrity at all.
ALTER TABLE public.vendor_credit_notes
  DROP CONSTRAINT IF EXISTS vendor_credit_notes_goods_receipt_id_fkey;
ALTER TABLE public.vendor_credit_notes
  ADD CONSTRAINT vendor_credit_notes_goods_receipt_id_fkey
  FOREIGN KEY (goods_receipt_id) REFERENCES public.goods_receipts(id) ON DELETE SET NULL;

ALTER TABLE public.vendor_credit_notes
  DROP CONSTRAINT IF EXISTS vendor_credit_notes_purchase_order_id_fkey;
ALTER TABLE public.vendor_credit_notes
  ADD CONSTRAINT vendor_credit_notes_purchase_order_id_fkey
  FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vcn_goods_receipt ON public.vendor_credit_notes(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_vcn_purchase_order ON public.vendor_credit_notes(purchase_order_id);

-- 3. Persist the outcome in the same transaction that closes the dispute.
CREATE OR REPLACE FUNCTION public.vendor_credit_note_resolve_dispute(_id uuid, _outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.vendor_credit_notes;
BEGIN
  IF _outcome NOT IN ('accepted','withdrawn') THEN
    RAISE EXCEPTION 'Dispute outcome must be accepted or withdrawn' USING ERRCODE='22023';
  END IF;
  v := public._vcn_load(_id);
  IF v.commercial_status <> 'disputed' THEN
    RAISE EXCEPTION 'This vendor credit note is not in dispute' USING ERRCODE='22023';
  END IF;
  UPDATE public.vendor_credit_notes
     SET commercial_status = CASE WHEN _outcome='accepted' THEN 'approved' ELSE 'cancelled' END,
         cancelled_by = CASE WHEN _outcome='withdrawn' THEN auth.uid() ELSE cancelled_by END,
         cancelled_at = CASE WHEN _outcome='withdrawn' THEN now() ELSE cancelled_at END,
         dispute_resolved_at=now(), dispute_resolved_by=auth.uid(),
         dispute_resolution=_outcome,
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  RETURN jsonb_build_object('success', true, 'outcome', _outcome);
END
$function$;