
CREATE OR REPLACE FUNCTION public.resolve_output_intent(
  p_document_kind text,
  p_organization_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL,
  p_scenario text DEFAULT 'default'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent        public.output_intents%ROWTYPE;
  v_targets       jsonb := '[]'::jsonb;
  v_policy        record;
  v_short_type    text;
  v_business_id   uuid;
  v_policy_target jsonb := NULL;
  v_policy_medium text;
  v_is_label      boolean;
BEGIN
  -- 1. Map full document kind_code -> the short doc_type used in document_print_policies.
  v_short_type := CASE p_document_kind
    WHEN 'sales.invoice'         THEN 'invoice'
    WHEN 'sales.estimate'        THEN 'estimate'
    WHEN 'sales.proforma'        THEN 'proforma'
    WHEN 'sales.credit_note'     THEN 'credit_note'
    WHEN 'sales.payment_receipt' THEN 'receipt'
    WHEN 'sales.delivery_note'   THEN 'delivery_note'
    WHEN 'sales.return'          THEN 'sales_return'
    WHEN 'sales.statement'       THEN 'customer_statement'
    WHEN 'sales.order_ack'       THEN 'sales_order'
    WHEN 'purchases.po'          THEN 'purchase_order'
    WHEN 'purchases.bill'        THEN 'bill'
    WHEN 'purchases.statement'   THEN 'vendor_statement'
    WHEN 'purchases.return'      THEN 'purchase_return'
    WHEN 'purchases.grn'         THEN 'grn'
    WHEN 'pos.receipt_customer'  THEN 'pos_receipt'
    WHEN 'pos.receipt_merchant'  THEN 'pos_receipt'
    WHEN 'pos.kitchen_ticket'    THEN 'kitchen_ticket'
    WHEN 'inventory.product_label'  THEN 'product_label'
    WHEN 'inventory.shipping_label' THEN 'shipping_label'
    WHEN 'inventory.price_label'    THEN 'price_label'
    WHEN 'inventory.shelf_label'    THEN 'shelf_label'
    WHEN 'inventory.pallet_label'   THEN 'pallet_label'
    WHEN 'inventory.item_barcode'   THEN 'item_barcode'
    ELSE p_document_kind
  END;

  v_is_label := v_short_type IN (
    'product_label','shipping_label','price_label',
    'shelf_label','pallet_label','item_barcode'
  );

  -- 2. Try to find a matching Output Policy. Policies live on `businesses`,
  --    so resolve org -> business first. Branch-scoped row wins over the
  --    business default. NB: we don't error if multiple businesses live
  --    under one organization — we take the primary one (min id) as the
  --    stable pick, matching the rest of the system.
  IF p_organization_id IS NOT NULL THEN
    SELECT b.id
      INTO v_business_id
    FROM public.businesses b
    WHERE b.organization_id = p_organization_id
    ORDER BY b.created_at, b.id
    LIMIT 1;

    IF v_business_id IS NOT NULL THEN
      SELECT p.*
        INTO v_policy
      FROM public.document_print_policies p
      WHERE p.business_id = v_business_id
        AND p.document_type = v_short_type
        AND (p.branch_id = p_branch_id OR p.branch_id IS NULL)
      ORDER BY (p.branch_id IS NOT DISTINCT FROM p_branch_id) DESC NULLS LAST,
               (p.branch_id IS NULL)                            ASC
      LIMIT 1;

      IF FOUND THEN
        -- Derive medium from policy shape.
        v_policy_medium := CASE
          WHEN v_is_label THEN 'zpl'
          WHEN v_policy.render_mode = 'escpos'
            OR v_policy.paper_format IN ('80mm','58mm','40mm')
            THEN 'escpos'
          ELSE 'pdf'
        END;

        -- Only synthesize a physical target when the trigger actually wants
        -- one. `preview_only` and `download_only` deliberately skip print.
        IF v_policy.trigger IN ('manual','auto')
           AND v_policy.role_code IS NOT NULL
           AND v_policy.role_code <> ''
        THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        v_policy_medium,
            'disposition',   'print',
            'hardware_role', v_policy.role_code,
            'template_code', NULL,
            'copies',        COALESCE(v_policy.copies, 1),
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format', v_policy.paper_format,
              'trigger',      v_policy.trigger::text,
              'source',       'document_print_policies',
              'policy_id',    v_policy.id
            )
          );
        ELSIF v_policy.trigger = 'download_only' THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        v_policy_medium,
            'disposition',   'download',
            'hardware_role', NULL,
            'template_code', NULL,
            'copies',        COALESCE(v_policy.copies, 1),
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format', v_policy.paper_format,
              'trigger',      v_policy.trigger::text,
              'source',       'document_print_policies',
              'policy_id',    v_policy.id
            )
          );
        END IF;
        -- trigger = 'preview_only' contributes no auto-dispatch target;
        -- callers see the resolved policy metadata and open a preview UI.
      END IF;
    END IF;
  END IF;

  -- 3. Existing output_intents lookup — unchanged shape. Keeps email /
  --    fiscal / webhook / archive channels working, and lets orgs that
  --    haven't authored a policy fall back on the system default.
  SELECT * INTO v_intent
  FROM public.output_intents
  WHERE document_kind = p_document_kind
    AND scenario IN (p_scenario, 'default')
    AND is_active = TRUE
    AND (
      (scope = 'branch'       AND organization_id = p_organization_id AND branch_id = p_branch_id) OR
      (scope = 'organization' AND organization_id = p_organization_id) OR
      (scope = 'system')
    )
  ORDER BY
    CASE WHEN scenario = p_scenario THEN 0 ELSE 1 END,
    CASE scope
      WHEN 'branch'       THEN 1
      WHEN 'organization' THEN 2
      WHEN 'tenant'       THEN 3
      WHEN 'system'       THEN 4
    END,
    priority ASC
  LIMIT 1;

  IF v_intent.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',            t.id,
        'medium',        t.medium,
        'disposition',   t.disposition,
        'hardware_role', t.hardware_role,
        'template_code', t.template_code,
        'copies',        t.copies,
        'priority',      t.priority,
        'params',        t.params
      ) ORDER BY t.priority ASC
    ), '[]'::jsonb)
    INTO v_targets
    FROM public.output_intent_targets t
    WHERE t.intent_id = v_intent.id AND t.is_active = TRUE;
  END IF;

  -- 4. Merge policy-derived target. When present, the policy owns the print
  --    channel and replaces any print target seeded from output_intents.
  IF v_policy_target IS NOT NULL THEN
    v_targets := COALESCE((
      SELECT jsonb_agg(elem)
      FROM jsonb_array_elements(v_targets) elem
      WHERE elem->>'disposition' <> (v_policy_target->>'disposition')
    ), '[]'::jsonb) || jsonb_build_array(v_policy_target);
  END IF;

  -- 5. Resolution is successful whenever either source contributed at least
  --    one target. Policies with trigger='preview_only' resolve with no
  --    auto-dispatch targets — callers treat empty target set as
  --    "preview and let the operator choose".
  IF v_intent.id IS NULL AND v_policy_target IS NULL AND v_policy.id IS NULL THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'no_intent_matched');
  END IF;

  RETURN jsonb_build_object(
    'resolved',    true,
    'intent_id',   v_intent.id,
    'intent_name', COALESCE(v_intent.name, 'policy_derived'),
    'scope',       COALESCE(v_intent.scope::text, 'organization'),
    'scenario',    COALESCE(v_intent.scenario, p_scenario),
    'targets',     v_targets,
    'policy_id',   v_policy.id,
    'policy_trigger', CASE WHEN v_policy.id IS NOT NULL THEN v_policy.trigger::text ELSE NULL END
  );
END;
$function$;
