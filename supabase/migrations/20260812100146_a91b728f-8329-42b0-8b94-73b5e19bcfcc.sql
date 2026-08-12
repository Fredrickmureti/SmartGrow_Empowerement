
-- ============================================================
-- ADR 0132 Phase 5 — vendor credit note document identity,
-- lifecycle events, and supplier dispute state.
-- ============================================================

-- ---------- 1. Document identity ----------
INSERT INTO public.document_kinds (
  code, label, domain, legal_class, default_media_class,
  default_intents, allowed_formats, requires_party, is_active
)
VALUES (
  'purchases.credit_note', 'Vendor Credit Note', 'purchases', 'commercial', 'a4_portrait',
  ARRAY['view','download','print','email'], ARRAY['pdf'], true, true
)
ON CONFLICT (code) DO UPDATE
  SET label           = EXCLUDED.label,
      default_intents = EXCLUDED.default_intents,
      requires_party  = EXCLUDED.requires_party,
      is_active       = true;

INSERT INTO public.document_template_ast (
  kind_code, scope, version, label, is_default, is_active, media_class, ast
)
SELECT 'purchases.credit_note', 'system', 1,
       'System default — Vendor Credit Note', true, true, 'a4_portrait',
  jsonb_build_object(
    'kind', 'purchases.credit_note',
    'version', 1,
    'media_class', 'a4_portrait',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','party','role','vendor'),
      jsonb_build_object('type','meta','fields',
        jsonb_build_array('number','date','currency')),
      jsonb_build_object('type','table','preset','line_items'),
      jsonb_build_object('type','totals','preset','standard'),
      jsonb_build_object('type','notes','source','terms'),
      jsonb_build_object('type','footer','variant','branded')
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
   WHERE kind_code = 'purchases.credit_note' AND scope = 'system' AND is_default
);

-- ---------- 2. Supplier dispute state ----------
ALTER TABLE public.vendor_credit_notes
  DROP CONSTRAINT IF EXISTS vcn_commercial_status_chk;
ALTER TABLE public.vendor_credit_notes
  ADD CONSTRAINT vcn_commercial_status_chk
  CHECK (commercial_status = ANY (ARRAY['draft','submitted','approved','rejected','cancelled','disputed']));

ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_by uuid,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_resolved_by uuid;

-- Transition guard: a supplier dispute is entered from submitted/approved and
-- leaves to approved (supplier conceded) or cancelled (we withdrew the claim).
CREATE OR REPLACE FUNCTION public.guard_vcn_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;

  IF NEW.commercial_status IS DISTINCT FROM OLD.commercial_status
     AND NOT (
       (OLD.commercial_status = 'draft'     AND NEW.commercial_status IN ('submitted','approved','cancelled')) OR
       (OLD.commercial_status = 'submitted' AND NEW.commercial_status IN ('approved','rejected','cancelled','draft','disputed')) OR
       (OLD.commercial_status = 'rejected'  AND NEW.commercial_status IN ('draft','cancelled')) OR
       (OLD.commercial_status = 'approved'  AND NEW.commercial_status IN ('cancelled','disputed')) OR
       (OLD.commercial_status = 'disputed'  AND NEW.commercial_status IN ('approved','cancelled'))
     ) THEN
    RAISE EXCEPTION 'Invalid vendor credit note commercial transition: % -> %',
      OLD.commercial_status, NEW.commercial_status USING ERRCODE='22023';
  END IF;

  IF NEW.accounting_status IS DISTINCT FROM OLD.accounting_status
     AND NOT (
       (OLD.accounting_status = 'unposted' AND NEW.accounting_status = 'posted') OR
       (OLD.accounting_status = 'posted'   AND NEW.accounting_status = 'reversed')
     ) THEN
    RAISE EXCEPTION 'Invalid vendor credit note accounting transition: % -> %',
      OLD.accounting_status, NEW.accounting_status USING ERRCODE='22023';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.vendor_credit_note_dispute(_id uuid, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v public.vendor_credit_notes;
BEGIN
  v := public._vcn_load(_id);
  IF v.commercial_status = 'disputed' THEN
    RETURN jsonb_build_object('success', true, 'already', true);
  END IF;
  IF v.commercial_status NOT IN ('submitted','approved') THEN
    RAISE EXCEPTION 'Only a submitted or approved vendor credit note can be disputed by the supplier'
      USING ERRCODE='22023';
  END IF;
  IF v.accounting_status = 'posted' THEN
    RAISE EXCEPTION 'A posted vendor credit note must be reversed, not disputed' USING ERRCODE='22023';
  END IF;
  UPDATE public.vendor_credit_notes
     SET commercial_status='disputed', disputed_by=auth.uid(), disputed_at=now(),
         dispute_reason=_reason, dispute_resolved_at=NULL, dispute_resolved_by=NULL,
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  RETURN jsonb_build_object('success', true);
END
$function$;

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
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  RETURN jsonb_build_object('success', true, 'outcome', _outcome);
END
$function$;

GRANT EXECUTE ON FUNCTION public.vendor_credit_note_dispute(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_credit_note_resolve_dispute(uuid, text) TO authenticated;

-- ---------- 3. Lifecycle events on the canonical outbox ----------
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES
  ('purchases.vendor_credit_note.', 'purchases', ARRAY['finance','purchases'], 'server',
   'Vendor credit note lifecycle: submitted, approved, rejected, disputed, cancelled, posted, applied, reversed.')
ON CONFLICT (topic_prefix) DO UPDATE
  SET producer_domain = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION public._emit_vcn_outbox(_vcn public.vendor_credit_notes, _state text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, source, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (
    _vcn.organization_id, 'purchases',
    'purchases.vendor_credit_note.' || _state,
    'vendor_credit_note', _vcn.id,
    jsonb_build_object(
      'credit_note_id',        _vcn.id,
      'credit_note_number',    _vcn.credit_note_number,
      'business_id',           _vcn.business_id,
      'branch_id',             _vcn.branch_id,
      'vendor_id',             _vcn.vendor_id,
      'bill_id',               _vcn.bill_id,
      'purchase_order_id',     _vcn.purchase_order_id,
      'goods_receipt_id',      _vcn.goods_receipt_id,
      'source_return_id',      _vcn.source_return_id,
      'origin',                _vcn.origin,
      'reason_code',           _vcn.reason_code,
      'currency',              _vcn.currency,
      'exchange_rate',         _vcn.exchange_rate,
      'total',                 _vcn.total,
      'amount_applied',        _vcn.amount_applied,
      'commercial_status',     _vcn.commercial_status,
      'accounting_status',     _vcn.accounting_status,
      'settlement_status',     _vcn.settlement_status,
      'journal_entry_id',      _vcn.journal_entry_id,
      'reversal_journal_entry_id', _vcn.reversal_journal_entry_id,
      'row_version',           _vcn.row_version
    ),
    'purchases.vendor_credit_note:' || _vcn.id::text || ':' || _state || ':'
      || COALESCE(_vcn.row_version::text, '0'),
    'pending', auth.uid(), now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END
$function$;

CREATE OR REPLACE FUNCTION public._vcn_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public._emit_vcn_outbox(NEW, 'created');
    RETURN NEW;
  END IF;

  IF NEW.commercial_status IS DISTINCT FROM OLD.commercial_status THEN
    PERFORM public._emit_vcn_outbox(NEW, NEW.commercial_status);
  END IF;

  IF NEW.accounting_status IS DISTINCT FROM OLD.accounting_status THEN
    PERFORM public._emit_vcn_outbox(
      NEW,
      CASE WHEN NEW.accounting_status = 'posted' THEN 'posted' ELSE NEW.accounting_status END);
  END IF;

  IF COALESCE(NEW.amount_applied,0) IS DISTINCT FROM COALESCE(OLD.amount_applied,0) THEN
    PERFORM public._emit_vcn_outbox(NEW, 'applied');
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tg_vcn_emit_lifecycle ON public.vendor_credit_notes;
CREATE TRIGGER tg_vcn_emit_lifecycle
  AFTER INSERT OR UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._vcn_emit_lifecycle();

NOTIFY pgrst, 'reload schema';
