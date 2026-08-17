-- Shared teardown gate: true only while reset_organization_data has flagged
-- the reset for this row's organization (or for a row with no org column).
CREATE OR REPLACE FUNCTION public._teardown_allows(p_row jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(NULLIF(current_setting('app.reset_in_progress', true), ''), '') = '' THEN false
    WHEN p_row ? 'organization_id' AND p_row->>'organization_id' IS NOT NULL
      THEN public._is_teardown_for_org((p_row->>'organization_id')::uuid)
    ELSE public._is_teardown_active()
  END
$function$;

GRANT EXECUTE ON FUNCTION public._teardown_allows(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._wms_task_events_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'wms_task_events is append-only (attempted %)', TG_OP
    USING ERRCODE = '42501';
END $function$;

CREATE OR REPLACE FUNCTION public._wms_crossdock_history_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'wms_crossdock_history is append-only';
END $function$;

CREATE OR REPLACE FUNCTION public._vcm_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'vendor_credit_movements is append-only';
END $function$;

CREATE OR REPLACE FUNCTION public.self_action_overrides_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.self_action_consume', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'self_action_overrides rows are immutable'
    USING ERRCODE = '42501';
END $function$;

CREATE OR REPLACE FUNCTION public._wms_billable_activities_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed text[] := ARRAY['invoice_id','disputed_at','dispute_reason',
                            'disputed_by','dispute_resolved_at','dispute_resolution'];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._teardown_allows(to_jsonb(OLD)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'wms_billable_activities is an immutable ledger; post a reversing entry instead';
  END IF;

  FOREACH k IN ARRAY v_allowed LOOP
    v_old := v_old - k;
    v_new := v_new - k;
  END LOOP;

  IF v_old IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION
      'wms_billable_activities is an immutable ledger; only invoice and dispute state may change';
  END IF;

  IF NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
     AND current_setting('wms.billing_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'dispute state may only change through wms_dispute_billable_activity';
  END IF;

  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_governance_events_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._teardown_allows(to_jsonb(OLD)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'governance_events is append-only; deletes are forbidden (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.event_type    IS DISTINCT FROM OLD.event_type
       OR NEW.module_keys   IS DISTINCT FROM OLD.module_keys
       OR NEW.actor_id      IS DISTINCT FROM OLD.actor_id
       OR NEW.payload       IS DISTINCT FROM OLD.payload
       OR NEW.started_at    IS DISTINCT FROM OLD.started_at
    THEN
      RAISE EXCEPTION 'governance_events row % is immutable; only result/finished_at/succeeded/error_message may be set.', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public._landed_cost_allocation_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' AND public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  SELECT status::text INTO v_status
    FROM public.landed_cost_vouchers
   WHERE id = COALESCE(OLD.voucher_id, NEW.voucher_id);

  IF v_status IS DISTINCT FROM 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LANDED_COST_ALLOCATION_IMMUTABLE: allocation lines of a posted voucher cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id
     OR NEW.component_id IS DISTINCT FROM OLD.component_id
     OR NEW.goods_receipt_item_id IS DISTINCT FROM OLD.goods_receipt_item_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.basis_value IS DISTINCT FROM OLD.basis_value
     OR NEW.basis_packaging_id IS DISTINCT FROM OLD.basis_packaging_id
     OR NEW.basis_qty IS DISTINCT FROM OLD.basis_qty
     OR NEW.basis_per_unit IS DISTINCT FROM OLD.basis_per_unit
     OR NEW.basis_uom_id IS DISTINCT FROM OLD.basis_uom_id
     OR NEW.allocation_ratio IS DISTINCT FROM OLD.allocation_ratio
     OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount THEN
    RAISE EXCEPTION 'LANDED_COST_ALLOCATION_IMMUTABLE: the allocation basis of a posted voucher cannot be changed — reverse the voucher instead'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.proforma_block_converted_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF public._teardown_allows(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF OLD.status = 'converted' OR OLD.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Proforma % has been converted to an invoice and cannot be deleted', OLD.proforma_number
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values)
  VALUES (OLD.organization_id, OLD.business_id, auth.uid(), 'deleted', 'proforma_invoice', OLD.id, OLD.proforma_number, to_jsonb(OLD));

  RETURN OLD;
END $function$;
