-- M4 · output intent resolution is PDF/browser only; no printer roles, no ESC/POS, no label media.
create or replace function public.resolve_output_intent(p_document_kind text, p_organization_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_scenario text DEFAULT 'default'::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_intent        public.output_intents%ROWTYPE;
  v_targets       jsonb := '[]'::jsonb;
  v_policy        record;
  v_short_type    text;
  v_business_id   uuid;
  v_policy_target jsonb := NULL;
  v_is_statement  boolean;
  v_paper         text;
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
    ELSE p_document_kind
  END;

  -- A statement is a financial report over a period, not a transactional
  -- document: it never inherits a transactional print policy target.
  v_is_statement := v_short_type IN ('customer_statement', 'vendor_statement');

  IF p_organization_id IS NOT NULL THEN
    SELECT b.id
      INTO v_business_id
    FROM public.businesses b
    WHERE b.organization_id = p_organization_id
    ORDER BY b.created_at, b.id
    LIMIT 1;

    IF v_business_id IS NOT NULL THEN
      SELECT p.id, p.paper_format, p.trigger, p.role_code, p.copies
        INTO v_policy
      FROM public.document_print_policies p
      WHERE p.business_id = v_business_id
        AND p.document_type = v_short_type
        AND (p.branch_id = p_branch_id OR p.branch_id IS NULL)
      ORDER BY (p.branch_id IS NOT DISTINCT FROM p_branch_id) DESC NULLS LAST,
               (p.branch_id IS NULL) ASC
      LIMIT 1;

      IF FOUND THEN
        -- Every output is a PDF rendered to the browser; narrow receipt
        -- paper sizes fall back to office paper.
        v_paper := CASE
          WHEN v_policy.paper_format IS NULL THEN 'a4'
          WHEN v_policy.paper_format IN ('80mm', '58mm', '40mm') THEN 'a4'
          ELSE v_policy.paper_format
        END;

        IF v_policy.trigger IN ('manual', 'auto') AND NOT v_is_statement THEN
          v_policy_target := jsonb_build_object(
            'id',            NULL,
            'medium',        'pdf',
            'disposition',   'print',
            'hardware_role', NULL,
            'template_code', NULL,
            'copies',        COALESCE(v_policy.copies, 1),
            'priority',      0,
            'params',        jsonb_build_object(
              'paper_format', v_paper,
              'trigger',      v_policy.trigger::text,
              'source',       'document_print_policies',
              'policy_id',    v_policy.id,
              'role_code',    v_policy.role_code
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
              'paper_format', v_paper,
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