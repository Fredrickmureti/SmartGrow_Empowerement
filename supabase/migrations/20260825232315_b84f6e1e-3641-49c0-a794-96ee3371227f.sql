CREATE OR REPLACE FUNCTION public.invoice_project_milestone(_milestone_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ms public.project_milestones%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_amount numeric;
  v_invoice_id uuid;
  v_invoice_number text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Lock the milestone: the row is the idempotency token for this operation.
  SELECT * INTO v_ms FROM public.project_milestones WHERE id = _milestone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'milestone_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = v_ms.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.project_can_read(v_project.id, v_uid) THEN
    RAISE EXCEPTION 'not_authorized_for_project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_has_module_permission(v_uid, v_project.organization_id, 'sales', 'create') THEN
    RAISE EXCEPTION 'not_authorized_to_invoice' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(v_ms.is_invoiced, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_invoiced', 'invoice_id', v_ms.invoice_id);
  END IF;

  v_amount := COALESCE(v_ms.billing_amount, 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'milestone_billing_amount_zero_or_missing' USING ERRCODE = '22023';
  END IF;

  IF v_project.customer_id IS NULL THEN
    RAISE EXCEPTION 'project_has_no_customer' USING ERRCODE = '22023';
  END IF;

  v_invoice_number := public.get_next_invoice_number(v_project.organization_id, v_project.business_id);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, contact_id, project_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, total, currency, notes, created_by
  ) VALUES (
    v_project.organization_id, v_project.business_id, v_project.branch_id,
    v_project.customer_id, v_project.id,
    v_invoice_number, 'draft', CURRENT_DATE, CURRENT_DATE + 30,
    v_amount, 0, v_amount, v_project.currency,
    'Milestone billing: ' || v_ms.name,
    v_uid
  ) RETURNING id INTO v_invoice_id;

  INSERT INTO public.invoice_items (
    invoice_id, business_id, description, quantity, unit_price,
    tax_rate, discount_percent, line_total, sort_order, project_id, milestone_id
  ) VALUES (
    v_invoice_id, v_project.business_id, 'Milestone: ' || v_ms.name,
    1, v_amount, 0, 0, v_amount, 0, v_project.id, v_ms.id
  );

  UPDATE public.project_milestones
     SET is_invoiced = true, invoice_id = v_invoice_id, updated_at = now()
   WHERE id = _milestone_id
     AND COALESCE(is_invoiced, false) = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'milestone_claim_conflict' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'amount', v_amount,
    'currency', v_project.currency
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.invoice_project_milestone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_project_milestone(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_project_milestone(uuid) TO service_role;