CREATE OR REPLACE FUNCTION public.resolve_output_intent(p_document_kind text, p_organization_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_scenario text DEFAULT 'default'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intent                    public.output_intents%ROWTYPE;
  v_targets                   jsonb := '[]'::jsonb;
  v_policy                    record;
  v_short_type                text;
  v_business_id               uuid;
  v_policy_target             jsonb := NULL;
  v_policy_medium             text;
  v_is_label                  boolean;
  v_is_statement              boolean;
  v_is_thermal_capable_kind   boolean;
  v_thermal_policy_requested  boolean;
  v_thermal_hardware_role     boolean;
  v_effective_paper           text;
  v_effective_hardware        text;
  v_coerced_to_pdf            boolean := false;
BEGIN
  v_short_type := CASE p_document_kind
    WHEN 'sales.invoice'            THEN 'invoice'
    WHEN 'sales.estimate'           THEN 'estimate'
    WHEN 'sales.proforma'           THEN 'proforma'
    WHEN 'sales.credit_note'        THEN 'credit_note'
    WHEN 'sales.payment_receipt'    THEN 'receipt'
    WHEN 'sales.delivery_note'      THEN 'delivery_note'
    WHEN 'sales.return'             THEN 'sales_return'
    WHEN 'sales.statement'          THEN 'customer_statement'
    WHEN 'sales.order_ack'          THEN 'sales_order'
    WHEN 'purchases.po'             THEN 'purchase_order'
    WHEN 'purchases.bill'           THEN 'bill'
    WHEN 'purchases.statement'      THEN 'vendor_statement'
    WHEN 'purchases.return'         THEN 'purchase_return'
    WHEN 'purchases.grn'            THEN 'grn'
    WHEN 'pos.receipt_customer'     THEN 'pos_receipt'
    WHEN 'pos.receipt_merchant'     THEN 'pos_receipt'
    WHEN 'pos.kitchen_ticket'       THEN 'kitchen_ticket'
    WHEN 'inventory.product_label'  THEN 'product_label'
    WHEN 'inventory.shipping_label' THEN 'shipping_label'
    WHEN 'inventory.price_label'    THEN 'price_label'
    WHEN 'inventory.shelf_label'    THEN 'shelf_label'
    WHEN 'inventory.pallet_label'   THEN 'pallet_label'
    WHEN 'inventory.item_barcode'   THEN 'item_barcode'
    ELSE p_document_kind
  END;

  v_is_label := v_short_type IN (
    'product_label', 'shipping_label', 'price_label',
    'shelf_label', 'pallet_label', 'item_barcode'
  );

  -- A statement is a financial report over a period, not a transactional
  -- document. It never inherits a transactional print policy's hardware
  -- target and it is never a thermal receipt: a "Download PDF" click must
  -- resolve to exactly one download target.
  v_is_statement := v_short_type IN ('customer_statement', 'vendor_statement');

  -- Thermal ESC/POS is a policy-controlled output medium, not a POS-only
  -- document class. Sales and Purchases documents may use it when the
  -- operator explicitly chooses ESC/POS on 40/58/80 mm paper and targets a
  -- thermal printer role. PDF remains the default and the office-paper path.
  v_is_thermal_capable_kind := v_short_type IN (
    'pos_receipt', 'kitchen_ticket',
    'invoice', 'estimate', 'proforma', 'credit_note', 'receipt',
    'delivery_note', 'sales_return', 'sales_order',
    'purchase_order', 'bill', 'purchase_return', 'grn'
  );

  IF p_organization_id IS NOT NULL THEN
    SELECT b.id
      INTO v_business_id
    FROM public.businesses b
    WHERE b.organization_id = p_organization_id
    ORDER BY b.created_at, b.id
    LIMIT 1;

    IF v_business_id IS NOT NULL THEN
      SELECT
        p.id,
        p.paper_format,
        p.render_mode,
        p.trigger,
        p.role_code,
        p.copies,
        pr.hardware_kind,
        pr.label AS role_label
      INTO v_policy
      FROM public.document_print_policies p
      LEFT JOIN public.printer_roles pr
        ON pr.organization_id = p_organization_id
       AND pr.code = p.role_code
       AND pr.is_active = true
      WHERE p.business_id = v_business_id
        AND p.document_type = v_short_type
        AND (p.branch_id = p_branch_id OR p.branch_id IS NULL)
      ORDER BY (p.branch_id IS NOT DISTINCT FROM p_branch_id) DESC NULLS LAST,
               (p.branch_id IS NULL) ASC
      LIMIT 1;

      IF FOUND THEN
        v_effective_paper := v_policy.paper_format;
        v_effective_hardware := COALESCE(v_policy.hardware_kind, v_policy.role_code);
        v_thermal_policy_requested :=
          v_policy.render_mode = 'escpos'
          AND v_policy.paper_format IN ('80mm', '58mm', '40mm');
        v_thermal_hardware_role := COALESCE(v_effective_hardware, '') IN (
          'receipt_printer', 'kitchen_printer',
          'receipt_thermal', 'kitchen_thermal', 'kitchen'
        );

        v_policy_medium := CASE
          WHEN v_is_label THEN 'zpl'
          WHEN v_thermal_policy_requested
            AND v_is_thermal_capable_kind
            AND v_thermal_hardware_role
            THEN 'escpos'
          WHEN v_short_type IN ('pos_receipt', 'kitchen_ticket')
            AND v_policy.paper_format IN ('80mm', '58mm', '40mm')
            AND v_thermal_hardware_role
            THEN 'escpos'
          ELSE 'pdf'
        END;

        v_coerced_to_pdf :=
          v_policy.render_mode = 'escpos'
          AND v_policy_medium = 'pdf';

        IF v_coerced_to_pdf THEN
          v_effective_hardware := 'a4_printer';
          IF v_effective_paper IS NULL
             OR v_effective_paper IN ('80mm', '58mm', '40mm') THEN
            v_effective_paper := 'a4';
          END IF;
        END IF;

        IF v_policy.trigger IN ('manual', 'auto')
           AND v_policy.role_code IS NOT NULL
           AND v_policy.role_code <> ''
           AND NOT v_is_statement
        THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        v_policy_medium,
            'disposition',   'print',
            'hardware_role', v_effective_hardware,
            'template_code', NULL,
            'copies',        COALESCE(v_policy.copies, 1),
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format',  v_effective_paper,
              'width',         CASE WHEN v_effective_paper IN ('80mm', '58mm', '40mm') THEN v_effective_paper ELSE NULL END,
              'trigger',       v_policy.trigger::text,
              'source',        'document_print_policies',
              'policy_id',     v_policy.id,
              'role_code',     v_policy.role_code,
              'role_label',    v_policy.role_label,
              'hardware_kind', v_effective_hardware,
              'coerced_to_pdf', v_coerced_to_pdf
            )
          );
        ELSIF v_policy.trigger = 'download_only' THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        'pdf',
            'disposition',   'download',
            'hardware_role', NULL,
            'template_code', NULL,
            'copies',        1,
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format', v_effective_paper,
              'trigger',      v_policy.trigger::text,
              'source',       'document_print_policies',
              'policy_id',    v_policy.id,
              'role_code',    v_policy.role_code
            )
          );
        END IF;
      END IF;
    END IF;
  END IF;

  SELECT *
    INTO v_intent
  FROM public.output_intents oi
  WHERE oi.document_kind = p_document_kind
    AND oi.scenario = p_scenario
    AND oi.is_active = true
    AND (
      (p_branch_id IS NOT NULL AND oi.scope = 'branch' AND oi.branch_id = p_branch_id) OR
      (p_organization_id IS NOT NULL AND oi.scope = 'organization' AND oi.organization_id = p_organization_id) OR
      oi.scope = 'system'
    )
  ORDER BY
    CASE oi.scope
      WHEN 'branch' THEN 1
      WHEN 'organization' THEN 2
      WHEN 'tenant' THEN 3
      ELSE 4
    END,
    oi.priority ASC,
    oi.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id',            t.id,
             'medium',        t.medium,
             'disposition',   t.disposition,
             'hardware_role', t.hardware_role,
             'template_code', t.template_code,
             'copies',        t.copies,
             'priority',      t.priority,
             'params',        COALESCE(t.params, '{}'::jsonb)
           ) ORDER BY t.priority), '[]'::jsonb)
      INTO v_targets
    FROM public.output_intent_targets t
    WHERE t.intent_id = v_intent.id
      AND t.is_active = true;
  END IF;

  IF v_policy_target IS NOT NULL THEN
    IF v_policy_target->>'disposition' = 'print' THEN
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        INTO v_targets
      FROM jsonb_array_elements(v_targets) elem
      WHERE elem->>'disposition' <> 'print';
    END IF;
    v_targets := jsonb_build_array(v_policy_target) || COALESCE(v_targets, '[]'::jsonb);
  END IF;

  IF v_intent.id IS NULL AND v_policy_target IS NULL THEN
    RETURN jsonb_build_object(
      'resolved', false,
      'reason', 'no_active_intent',
      'document_kind', p_document_kind,
      'scenario', p_scenario,
      'targets', '[]'::jsonb
    );
  END IF;

  RETURN jsonb_build_object(
    'resolved', true,
    'intent_id', COALESCE(v_intent.id, '00000000-0000-0000-0000-000000000000'::uuid),
    'intent_name', COALESCE(v_intent.name, 'Output policy'),
    'scope', COALESCE(v_intent.scope::text, 'business'),
    'scenario', p_scenario,
    'targets', COALESCE(v_targets, '[]'::jsonb)
  );
END;
$function$;

-- Retire every statement artifact rendered before the statement-renderer
-- routing fix (2026-08-10 04:31 UTC). Those bytes are invoice-shaped and
-- must never be served again from download, email, archive or history.
UPDATE public.document_artifacts
   SET superseded_by = id,
       regeneration_reason = COALESCE(regeneration_reason, 'quarantined: invoice-shaped statement layout (pre routing fix)')
 WHERE document_type IN ('customer_statement', 'vendor_statement', 'sales.statement', 'purchases.statement')
   AND created_at < '2026-08-10 04:31:00+00'
   AND superseded_by IS NULL;

CREATE OR REPLACE FUNCTION public.document_artifacts_latest(p_business_id uuid, p_document_type text, p_document_id uuid)
 RETURNS SETOF document_artifacts
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT *
  FROM public.document_artifacts
  WHERE business_id   = p_business_id
    AND document_type = p_document_type
    AND document_id   = p_document_id
    AND superseded_by IS NULL
  ORDER BY version DESC, created_at DESC
  LIMIT 1;
$function$;