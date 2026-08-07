-- ============================================================================
-- Phase 2 — Reversal consequence preview
--
-- Enterprise reversal UX has three steps: intent (what is legal), preview
-- (what will change), execute (atomic). Phase 1 delivered intent. This
-- migration delivers preview as a STABLE, read-only projection built from the
-- same sources the executing writers use, so the preview cannot drift from the
-- outcome:
--   * GL      -> journal_entries/journal_entry_lines sourced from the document
--                (exactly what void_journal_entry_atomic would mirror)
--   * stock   -> stock_movements with reference_type/id of the document
--                (exactly what restore_invoice_stock_atomic would mirror)
--   * money   -> payment_allocations (ADR 0027 allocation ledger)
--   * docs    -> delivery notes, credit notes, fiscal transmissions
-- The preview NEVER re-derives legality; it embeds resolve_reversal_intent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.preview_reversal_consequences(
  _document_type text,
  _document_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent      jsonb;
  v_org         uuid;
  v_biz         uuid;
  v_gl          jsonb := '[]'::jsonb;
  v_gl_total    numeric := 0;
  v_stock       jsonb := '[]'::jsonb;
  v_money       jsonb := '[]'::jsonb;
  v_docs        jsonb := '[]'::jsonb;
  v_warnings    jsonb := '[]'::jsonb;
  v_fiscalized  boolean := false;
  v_dn_count    int := 0;
  v_cn_count    int := 0;
  v_inv         public.invoices%ROWTYPE;
BEGIN
  -- Intent first: it performs the tenant authorization check and raises for
  -- unknown document types / missing documents. One authority, one error text.
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);
  v_org := NULLIF(v_intent->>'organization_id', '')::uuid;
  v_biz := NULLIF(v_intent->>'business_id', '')::uuid;

  -- ------------------------------------------------------------------ GL
  -- Same predicate the void writers walk: live entries sourced from the
  -- document. Debits/credits are shown as they WOULD BE MIRRORED (inverted),
  -- because that is what the user is about to authorise.
  WITH jes AS (
    SELECT je.id,
           je.entry_number,
           je.entry_date,
           COALESCE(je.source_subtype, 'main') AS subtype,
           COALESCE(je.total_debit, 0)         AS total_debit,
           je.status::text                     AS status
      FROM public.journal_entries je
     WHERE je.organization_id = v_org
       AND je.status::text NOT IN ('voided', 'reversed')
       AND je.source_type = _document_type
       AND je.source_id   = _document_id
  ),
  lines AS (
    SELECT jel.journal_entry_id,
           jsonb_agg(jsonb_build_object(
             'account_id',     jel.account_id,
             'account_code',   a.code,
             'account_name',   a.name,
             -- inverted on purpose: the reversal's shape, not the original's
             'reverse_debit',  COALESCE(jel.credit, 0),
             'reverse_credit', COALESCE(jel.debit, 0)
           ) ORDER BY a.code) AS lines
      FROM public.journal_entry_lines jel
      LEFT JOIN public.accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id IN (SELECT id FROM jes)
     GROUP BY jel.journal_entry_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'journal_entry_id', jes.id,
           'entry_number',     jes.entry_number,
           'entry_date',       jes.entry_date,
           'subtype',          jes.subtype,
           'total',            jes.total_debit,
           'status',           jes.status,
           'lines',            COALESCE(lines.lines, '[]'::jsonb)
         ) ORDER BY jes.subtype), '[]'::jsonb),
         COALESCE(SUM(jes.total_debit), 0)
    INTO v_gl, v_gl_total
    FROM jes LEFT JOIN lines ON lines.journal_entry_id = jes.id;

  -- --------------------------------------------------------------- invoice
  IF _document_type = 'invoice' THEN
    SELECT * INTO v_inv FROM public.invoices WHERE id = _document_id;

    -- Stock that restore_invoice_stock_atomic would mirror as return_in.
    -- Products with track_inventory = false are deliberately excluded there,
    -- so they are excluded here too.
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'product_name'), '[]'::jsonb)
      INTO v_stock
      FROM (
        SELECT jsonb_build_object(
                 'product_id',     sm.product_id,
                 'product_name',   p.name,
                 'product_sku',    p.sku,
                 'warehouse_id',   sm.warehouse_id,
                 'warehouse_name', w.name,
                 'quantity',       SUM(sm.quantity),
                 'unit_cost',      MAX(sm.unit_cost),
                 'direction',      'return_in'
               ) AS x
          FROM public.stock_movements sm
          JOIN public.products p ON p.id = sm.product_id
          LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
         WHERE sm.reference_type = 'invoice'
           AND sm.reference_id   = _document_id
           AND COALESCE(p.track_inventory, false) = true
         GROUP BY sm.product_id, p.name, p.sku, sm.warehouse_id, w.name
      ) s;

    -- Already restored? Then a void would restore nothing (idempotent writer).
    IF EXISTS (
      SELECT 1 FROM public.stock_movements
       WHERE reference_type = 'invoice_void' AND reference_id = _document_id
    ) THEN
      v_stock := '[]'::jsonb;
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'stock_already_restored',
        'severity', 'info',
        'message', 'Stock for this invoice was already returned to inventory. No further stock movement would be created.');
    END IF;

    -- Money: live settlement, through the allocation ledger.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'payment_id',       p.id,
             'receipt_number',   p.receipt_number,
             'payment_date',     p.payment_date,
             'payment_method',   p.payment_method,
             'allocated_amount', a.amount,
             'payment_amount',   p.amount,
             'bank_reconciled',  public.payment_is_bank_reconciled(p.id)
           ) ORDER BY p.payment_date), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = _document_id
       AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

    -- Related documents.
    SELECT count(*) INTO v_dn_count
      FROM public.delivery_notes dn
     WHERE dn.invoice_id = _document_id
       AND COALESCE(dn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT count(*) INTO v_cn_count
      FROM public.credit_notes cn
     WHERE cn.invoice_id = _document_id
       AND COALESCE(cn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT EXISTS (
      SELECT 1 FROM public.fiscal_transmissions ft
       WHERE ft.document_type = 'invoice'
         AND ft.document_id = _document_id
         AND COALESCE(ft.status::text, '') IN ('accepted', 'transmitted', 'success')
    ) INTO v_fiscalized;

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'delivery_note', 'label', 'Delivery notes', 'count', v_dn_count),
      jsonb_build_object('kind', 'credit_note',   'label', 'Credit notes',   'count', v_cn_count)
    );

    IF v_fiscalized THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'fiscal_transmitted',
        'severity', 'warning',
        'message', 'This invoice was already transmitted to the tax authority. Most jurisdictions require a credit note to cancel a fiscalised invoice — a local void does not withdraw the transmission.');
    END IF;

    IF v_dn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'delivery_note_linked',
        'severity', 'warning',
        'message', v_dn_count || ' delivery note(s) reference this invoice. Goods dispatched on a delivery note are returned through a sales return, not by voiding the invoice.');
    END IF;

    IF v_cn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'credit_note_exists',
        'severity', 'warning',
        'message', v_cn_count || ' credit note(s) already correct this invoice. Reversing it again would compensate the customer twice.');
    END IF;

  -- --------------------------------------------------------------- payment
  ELSIF _document_type = 'payment' THEN
    -- Money: the invoices this payment settles, and the balance they return to.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'invoice_id',        i.id,
             'invoice_number',    i.invoice_number,
             'invoice_total',     i.total,
             'allocated_amount',  a.amount,
             'amount_paid_now',   i.amount_paid,
             'amount_paid_after', GREATEST(COALESCE(i.amount_paid, 0) - a.amount, 0),
             'status_now',        i.status::text
           ) ORDER BY i.invoice_number), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.invoices i ON i.id = a.invoice_id
     WHERE a.payment_id = _document_id;

    IF public.payment_is_bank_reconciled(_document_id) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'bank_reconciled',
        'severity', 'error',
        'message', 'This payment is matched to a reconciled bank statement line. Un-reconcile the bank line before reversing, or the reconciliation and the ledger will disagree.');
    END IF;
  END IF;

  IF jsonb_array_length(v_gl) = 0 AND (v_intent->'state'->>'is_posted')::boolean THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'no_gl_entry',
      'severity', 'warning',
      'message', 'No live accounting entry was found for this posted document. Reversing it changes the document only — check the ledger before continuing.');
  END IF;

  RETURN jsonb_build_object(
    'document_type',      _document_type,
    'document_id',        _document_id,
    'document_number',    v_intent->>'document_number',
    'organization_id',    v_org,
    'business_id',        v_biz,
    'intent',             v_intent,
    'gl',                 jsonb_build_object(
                            'entries', v_gl,
                            'entry_count', jsonb_array_length(v_gl),
                            'total_reversed', v_gl_total),
    'stock',              jsonb_build_object(
                            'lines', v_stock,
                            'line_count', jsonb_array_length(v_stock)),
    'money',              jsonb_build_object(
                            'lines', v_money,
                            'line_count', jsonb_array_length(v_money)),
    'related_documents',  v_docs,
    'warnings',           v_warnings
  );
END;
$$;

COMMENT ON FUNCTION public.preview_reversal_consequences(text, uuid) IS
  'Phase 2 reversal consequence preview. Read-only projection of the GL, stock, settlement and document impact of reversing a document, built from the same sources the atomic writers use. Embeds resolve_reversal_intent for legality; never re-derives it.';

REVOKE ALL ON FUNCTION public.preview_reversal_consequences(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences(text, uuid) TO service_role;