-- Hard-cut the deprecated split-brain print routing layer.
-- The single runtime device registry is now public.device_assignments.

-- 1) Normalize printer role hardware kinds to actual device roles before any resolver uses them.
UPDATE public.printer_roles
SET hardware_kind = CASE hardware_kind
  WHEN 'office_printer' THEN 'a4_printer'
  WHEN 'fiscal_device' THEN 'a4_printer'
  ELSE hardware_kind
END
WHERE hardware_kind IN ('office_printer', 'fiscal_device');

-- 2) Keep the unified Output Policy shape only.
ALTER TABLE public.document_print_policies
  DROP COLUMN IF EXISTS device_assignment_id,
  DROP COLUMN IF EXISTS auto_print;

-- 3) Remove the old secondary branch-binding router entirely.
DROP FUNCTION IF EXISTS public.resolve_hardware_assignment(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.print_policies_resolve(uuid, uuid, text, text);
DROP TABLE IF EXISTS public.printer_role_branch_bindings;

-- 4) Resolve output intent from Output Policy -> printer_roles.hardware_kind.
--    hardware_role in the emitted target is the real device_assignments.role
--    (receipt_printer / label_printer / kitchen_printer / a4_printer), not the
--    semantic role code. The selected role code remains in params for audit/UI.
CREATE OR REPLACE FUNCTION public.resolve_output_intent(
  p_document_kind text,
  p_organization_id uuid DEFAULT NULL::uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_scenario text DEFAULT 'default'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
        v_policy_medium := CASE
          WHEN v_is_label THEN 'zpl'
          WHEN v_policy.render_mode = 'escpos'
            OR v_policy.paper_format IN ('80mm', '58mm', '40mm')
            THEN 'escpos'
          ELSE 'pdf'
        END;

        IF v_policy.trigger IN ('manual', 'auto')
           AND v_policy.role_code IS NOT NULL
           AND v_policy.role_code <> ''
        THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        v_policy_medium,
            'disposition',   'print',
            'hardware_role', COALESCE(v_policy.hardware_kind, v_policy.role_code),
            'template_code', NULL,
            'copies',        COALESCE(v_policy.copies, 1),
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format',  v_policy.paper_format,
              'trigger',       v_policy.trigger::text,
              'source',        'document_print_policies',
              'policy_id',     v_policy.id,
              'role_code',     v_policy.role_code,
              'role_label',    v_policy.role_label,
              'hardware_kind', COALESCE(v_policy.hardware_kind, v_policy.role_code)
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
              'paper_format', v_policy.paper_format,
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
      (p_branch_id IS NOT NULL AND oi.scope = 'branch' AND oi.scope_id = p_branch_id) OR
      (p_organization_id IS NOT NULL AND oi.scope = 'organization' AND oi.scope_id = p_organization_id) OR
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

-- 5) Re-create resolve_device explicitly as the only device resolver used by jobs and UI.
CREATE OR REPLACE FUNCTION public.resolve_device(
  _organization_id uuid,
  _role text,
  _business_id uuid DEFAULT NULL::uuid,
  _scope_kind text DEFAULT NULL::text,
  _scope_id uuid DEFAULT NULL::uuid
)
RETURNS SETOF public.device_assignments
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT da.*
  FROM public.device_assignments da
  WHERE da.organization_id = _organization_id
    AND da.role = _role
    AND da.enabled = true
    AND (_business_id IS NULL OR da.business_id IS NULL OR da.business_id = _business_id)
    AND (
      _scope_kind IS NULL
      OR da.scope_kind = 'tenant'
      OR (da.scope_kind = _scope_kind AND da.scope_id IS NOT DISTINCT FROM _scope_id)
    )
  ORDER BY
    CASE
      WHEN _scope_kind IS NOT NULL
       AND da.scope_kind = _scope_kind
       AND da.scope_id IS NOT DISTINCT FROM _scope_id THEN 0
      WHEN da.business_id = _business_id THEN 1
      WHEN da.scope_kind = 'tenant' THEN 2
      ELSE 3
    END,
    da.is_default DESC,
    CASE da.status WHEN 'online' THEN 0 WHEN 'ready' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,
    da.last_seen_at DESC NULLS LAST,
    da.created_at ASC
  LIMIT 1
$function$;