-- =====================================================================
-- RFQ Phase 4b — supplier bid attachments
-- Attachments are bound to a quotation VERSION. They are never mutated:
-- a revised quote copies the prior version's rows (same storage object).
-- =====================================================================

CREATE TABLE public.rfq_quotation_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES public.rfq_quotations(id) ON DELETE CASCADE,
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  attachment_kind text NOT NULL DEFAULT 'bid_document',
  uploaded_by uuid,
  uploaded_via text NOT NULL DEFAULT 'portal',
  carried_forward_from uuid REFERENCES public.rfq_quotation_attachments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_quotation_attachments_unique_path UNIQUE (quotation_id, file_path),
  CONSTRAINT rfq_quotation_attachments_kind_chk CHECK (
    attachment_kind IN ('bid_document','technical_spec','certificate','price_list','other')
  )
);

CREATE INDEX idx_rfq_quotation_attachments_quotation ON public.rfq_quotation_attachments(quotation_id);
CREATE INDEX idx_rfq_quotation_attachments_rfq ON public.rfq_quotation_attachments(rfq_id);

GRANT SELECT ON public.rfq_quotation_attachments TO authenticated;
GRANT ALL ON public.rfq_quotation_attachments TO service_role;

ALTER TABLE public.rfq_quotation_attachments ENABLE ROW LEVEL SECURITY;

-- Reads only. Every write goes through the SECURITY DEFINER RPCs below so the
-- lifecycle rules (live version, deadline, invited supplier) cannot be bypassed.
CREATE POLICY rfq_quotation_attachments_staff_select
  ON public.rfq_quotation_attachments FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY rfq_quotation_attachments_portal_select
  ON public.rfq_quotation_attachments FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()));

COMMENT ON TABLE public.rfq_quotation_attachments IS
  'Supplier bid attachments bound to an rfq_quotations version. Immutable: revisions copy rows forward. Writes only via rfq_attach_quotation_document / rfq_remove_quotation_attachment.';

-- ---------------------------------------------------------------------
-- Storage policies (bucket rfq-bid-attachments, private).
-- Vendor-portal users have no org role, so the shared `documents` bucket
-- policies cannot serve them.
-- Object key layout: {rfq_id}/{quotation_id}/{uuid}-{filename}
-- ---------------------------------------------------------------------
CREATE POLICY rfq_bid_attachments_staff_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'rfq-bid-attachments'
    AND EXISTS (
      SELECT 1 FROM public.rfqs r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND public.user_can_access_business(auth.uid(), r.business_id)
    )
  );

CREATE POLICY rfq_bid_attachments_supplier_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'rfq-bid-attachments'
    AND EXISTS (
      SELECT 1 FROM public.rfq_invitations i
      JOIN public.contacts c ON c.id = i.supplier_id AND c.portal_user_id = auth.uid()
      WHERE i.rfq_id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY rfq_bid_attachments_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'rfq-bid-attachments'
    AND (
      EXISTS (
        SELECT 1 FROM public.rfq_invitations i
        JOIN public.contacts c ON c.id = i.supplier_id AND c.portal_user_id = auth.uid()
        WHERE i.rfq_id::text = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1 FROM public.rfqs r
        WHERE r.id::text = (storage.foldername(name))[1]
          AND public.user_can_access_business(auth.uid(), r.business_id)
      )
    )
  );

-- No DELETE / UPDATE policy on purpose: bid evidence is write-once. Removing an
-- attachment detaches the row; the object stays for audit.

-- ---------------------------------------------------------------------
-- Attach
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rfq_attach_quotation_document(
  _quotation_id uuid,
  _file_path text,
  _file_name text,
  _mime_type text DEFAULT NULL,
  _file_size bigint DEFAULT NULL,
  _kind text DEFAULT 'bid_document'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  q public.rfq_quotations; inv public.rfq_invitations; v public.rfqs;
  v_is_portal boolean; v_id uuid;
BEGIN
  SELECT * INTO q FROM rfq_quotations WHERE id = _quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found'; END IF;
  SELECT * INTO inv FROM rfq_invitations WHERE id = q.invitation_id;
  SELECT * INTO v FROM rfqs WHERE id = q.rfq_id;

  v_is_portal := EXISTS (
    SELECT 1 FROM contacts c WHERE c.id = q.supplier_id AND c.portal_user_id = auth.uid()
  );
  IF NOT v_is_portal AND NOT user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised to attach documents to this quotation';
  END IF;

  IF q.state <> 'submitted' THEN
    RAISE EXCEPTION 'Quotation version % is no longer the live bid (%)', q.quotation_version, q.state;
  END IF;

  IF v_is_portal AND inv.response_deadline IS NOT NULL AND now() > inv.response_deadline THEN
    RAISE EXCEPTION 'The response deadline for RFQ % has passed', v.rfq_number;
  END IF;

  IF _file_path IS NULL OR _file_path NOT LIKE (q.rfq_id::text || '/' || q.id::text || '/%') THEN
    RAISE EXCEPTION 'Attachment path must live under %/%/', q.rfq_id, q.id;
  END IF;

  INSERT INTO rfq_quotation_attachments (
    quotation_id, rfq_id, business_id, supplier_id, file_path, file_name,
    mime_type, file_size, attachment_kind, uploaded_by, uploaded_via)
  VALUES (q.id, q.rfq_id, v.business_id, q.supplier_id, _file_path, _file_name,
    _mime_type, _file_size, COALESCE(NULLIF(_kind, ''), 'bid_document'), auth.uid(),
    CASE WHEN v_is_portal THEN 'portal' ELSE 'internal' END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.rfq_attach_quotation_document(uuid, text, text, text, bigint, text) IS
  'Registers a supplier bid attachment against the live quotation version. Only entry point for writes to rfq_quotation_attachments.';

-- ---------------------------------------------------------------------
-- Detach (row only; the stored object is retained for audit)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rfq_remove_quotation_attachment(_attachment_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  a public.rfq_quotation_attachments; q public.rfq_quotations;
  inv public.rfq_invitations; v_is_portal boolean;
BEGIN
  SELECT * INTO a FROM rfq_quotation_attachments WHERE id = _attachment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO q FROM rfq_quotations WHERE id = a.quotation_id FOR UPDATE;
  SELECT * INTO inv FROM rfq_invitations WHERE id = q.invitation_id;

  v_is_portal := EXISTS (
    SELECT 1 FROM contacts c WHERE c.id = a.supplier_id AND c.portal_user_id = auth.uid()
  );
  IF NOT v_is_portal AND NOT user_can_access_business(auth.uid(), a.business_id) THEN
    RAISE EXCEPTION 'Not authorised to remove this attachment';
  END IF;

  IF q.state <> 'submitted' THEN
    RAISE EXCEPTION 'Attachments on a % quotation are immutable', q.state;
  END IF;
  IF v_is_portal AND inv.response_deadline IS NOT NULL AND now() > inv.response_deadline THEN
    RAISE EXCEPTION 'The response deadline has passed';
  END IF;

  DELETE FROM rfq_quotation_attachments WHERE id = _attachment_id;
  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.rfq_remove_quotation_attachment(uuid) IS
  'Detaches an attachment from the live quotation version. Superseded versions keep their evidence.';

-- ---------------------------------------------------------------------
-- Carry attachments forward when a supplier revises their bid.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rfq_record_quotation(_invitation_id uuid, _header jsonb, _lines jsonb, _allow_late boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.rfqs; inv public.rfq_invitations; prev public.rfq_quotations;
  v_is_portal boolean; v_q_id uuid; v_version int; v_late boolean := false;
  v_sub numeric := 0; v_tax numeric := 0; v_freight numeric;
BEGIN
  SELECT * INTO inv FROM rfq_invitations WHERE id = _invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  SELECT * INTO v FROM rfqs WHERE id = inv.rfq_id FOR UPDATE;

  v_is_portal := EXISTS (SELECT 1 FROM contacts c WHERE c.id = inv.supplier_id AND c.portal_user_id = auth.uid());
  IF NOT v_is_portal AND NOT user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised to quote on this RFQ';
  END IF;
  IF inv.rfq_version <> v.version THEN
    RAISE EXCEPTION 'This RFQ has been revised — the invitation is out of date';
  END IF;
  IF v.status NOT IN ('sent','responses_received','under_evaluation') THEN
    RAISE EXCEPTION 'RFQ % is not open for quotations (%)', v.rfq_number, v.status;
  END IF;
  IF inv.invitation_state IN ('withdrawn','superseded') THEN
    RAISE EXCEPTION 'This invitation is no longer active';
  END IF;

  IF inv.response_deadline IS NOT NULL AND now() > inv.response_deadline THEN
    IF v_is_portal AND NOT _allow_late THEN
      RAISE EXCEPTION 'The response deadline for RFQ % has passed', v.rfq_number;
    END IF;
    v_late := true;
  END IF;

  SELECT * INTO prev FROM rfq_quotations
   WHERE invitation_id = _invitation_id AND state = 'submitted' FOR UPDATE;
  v_version := COALESCE(prev.quotation_version, 0) + 1;
  v_freight := COALESCE((_header->>'freight_amount')::numeric, 0);

  INSERT INTO rfq_quotations (rfq_id, invitation_id, supplier_id, rfq_version, quotation_version,
    state, supplier_reference, currency, subtotal, tax_total, freight_amount, total,
    lead_time_days, incoterms, payment_terms, valid_until, notes,
    submitted_by, submitted_via, is_late)
  VALUES (v.id, inv.id, inv.supplier_id, v.version, v_version, 'submitted',
    _header->>'supplier_reference',
    COALESCE(NULLIF(_header->>'currency',''), v.currency, 'USD'),
    0, 0, v_freight, 0,
    NULLIF(_header->>'lead_time_days','')::int, _header->>'incoterms', _header->>'payment_terms',
    NULLIF(_header->>'valid_until','')::date, _header->>'notes',
    auth.uid(), CASE WHEN v_is_portal THEN 'portal' ELSE 'internal' END, v_late)
  RETURNING id INTO v_q_id;

  INSERT INTO rfq_quotation_items (quotation_id, rfq_item_id, product_id, alternate_product_id,
    is_alternate, supplier_product_code, description, quoted_quantity, quoted_uom_id,
    unit_price, discount_percent, tax_rate, tax_amount, line_total, lead_time_days,
    delivery_date, notes, sort_order)
  SELECT v_q_id, ri.id, ri.product_id,
    NULLIF(l->>'alternate_product_id','')::uuid,
    COALESCE((l->>'is_alternate')::boolean, false),
    l->>'supplier_product_code', COALESCE(l->>'description', ri.description),
    COALESCE((l->>'quoted_quantity')::numeric, ri.quantity),
    COALESCE(NULLIF(l->>'quoted_uom_id','')::uuid, ri.uom_id),
    COALESCE((l->>'unit_price')::numeric, 0),
    COALESCE((l->>'discount_percent')::numeric, 0),
    COALESCE((l->>'tax_rate')::numeric, 0),
    ROUND(COALESCE((l->>'quoted_quantity')::numeric, ri.quantity)
        * COALESCE((l->>'unit_price')::numeric, 0)
        * (1 - COALESCE((l->>'discount_percent')::numeric, 0) / 100)
        * COALESCE((l->>'tax_rate')::numeric, 0) / 100, 6),
    ROUND(COALESCE((l->>'quoted_quantity')::numeric, ri.quantity)
        * COALESCE((l->>'unit_price')::numeric, 0)
        * (1 - COALESCE((l->>'discount_percent')::numeric, 0) / 100), 6),
    NULLIF(l->>'lead_time_days','')::int, NULLIF(l->>'delivery_date','')::date,
    l->>'notes', COALESCE(ri.sort_order, 0)
  FROM jsonb_array_elements(COALESCE(_lines, '[]'::jsonb)) l
  JOIN rfq_items ri ON ri.id = (l->>'rfq_item_id')::uuid AND ri.rfq_id = v.id;

  SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(tax_amount),0)
    INTO v_sub, v_tax FROM rfq_quotation_items WHERE quotation_id = v_q_id;
  UPDATE rfq_quotations SET subtotal = v_sub, tax_total = v_tax,
    total = v_sub + v_tax + v_freight WHERE id = v_q_id;

  IF prev.id IS NOT NULL THEN
    -- Bid evidence follows the live version; the superseded version keeps its own rows.
    INSERT INTO rfq_quotation_attachments (
      quotation_id, rfq_id, business_id, supplier_id, file_path, file_name,
      mime_type, file_size, attachment_kind, uploaded_by, uploaded_via, carried_forward_from)
    SELECT v_q_id, a.rfq_id, a.business_id, a.supplier_id, a.file_path, a.file_name,
      a.mime_type, a.file_size, a.attachment_kind, a.uploaded_by, a.uploaded_via, a.id
    FROM rfq_quotation_attachments a
    WHERE a.quotation_id = prev.id
    ON CONFLICT (quotation_id, file_path) DO NOTHING;

    UPDATE rfq_quotations SET state = 'superseded', superseded_by = v_q_id WHERE id = prev.id;
  END IF;

  UPDATE rfq_invitations SET invitation_state = 'quoted', updated_at = now() WHERE id = inv.id;
  UPDATE rfqs SET status = CASE WHEN status = 'sent' THEN 'responses_received' ELSE status END,
    updated_at = now() WHERE id = v.id;

  PERFORM _rfq_emit(v, CASE WHEN prev.id IS NULL THEN 'rfq.quotation_received' ELSE 'rfq.quotation_revised' END,
    jsonb_build_object('quotation_id', v_q_id, 'supplier_id', inv.supplier_id, 'total', v_sub + v_tax + v_freight), auth.uid());

  RETURN jsonb_build_object('success', true, 'quotation_id', v_q_id, 'version', v_version, 'is_late', v_late);
END;
$function$;
