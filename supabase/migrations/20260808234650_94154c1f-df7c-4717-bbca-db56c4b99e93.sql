-- 1. Business-level proforma prefix
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS proforma_prefix text;

-- 2. Status vocabulary: add 'cancelled'
ALTER TABLE public.proforma_invoices DROP CONSTRAINT IF EXISTS proforma_invoices_status_check;
ALTER TABLE public.proforma_invoices ADD CONSTRAINT proforma_invoices_status_check
  CHECK (status IN ('draft','sent','accepted','rejected','expired','cancelled','converted'));

-- 3. Uniqueness of the externally-issued number
CREATE UNIQUE INDEX IF NOT EXISTS ux_proforma_invoices_number
  ON public.proforma_invoices (organization_id, business_id, proforma_number);

-- 4. Hardened numbering (business scoped + advisory lock)
DROP FUNCTION IF EXISTS public.get_next_proforma_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_proforma_number(_org_id uuid, _business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_next int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'Organization and business are required to allocate a proforma number'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('proforma_number_' || _business_id::text));

  SELECT COALESCE(NULLIF(btrim(b.proforma_prefix), ''), 'PI-')
    INTO v_prefix
  FROM public.businesses b
  WHERE b.id = _business_id;
  v_prefix := COALESCE(v_prefix, 'PI-');

  SELECT COALESCE(MAX((regexp_replace(proforma_number, '^.*-', ''))::int), 0) + 1
    INTO v_next
  FROM public.proforma_invoices
  WHERE organization_id = _org_id
    AND business_id = _business_id
    AND proforma_number LIKE v_prefix || v_year || '-%'
    AND proforma_number ~ '-[0-9]+$';

  RETURN v_prefix || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;

-- 5. Lifecycle guards -------------------------------------------------
CREATE OR REPLACE FUNCTION public.proforma_status_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('app.proforma_status_writer', true), '') <> '1' THEN
    RAISE EXCEPTION 'Proforma status must be changed through set_proforma_status_atomic()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.proforma_freeze_after_convert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'converted' AND COALESCE(current_setting('app.proforma_status_writer', true), '') <> '1' THEN
    IF NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.proforma_number IS DISTINCT FROM OLD.proforma_number
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Converted proforma % is immutable', OLD.proforma_number
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.proforma_block_converted_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'converted' OR OLD.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Proforma % has been converted to an invoice and cannot be deleted', OLD.proforma_number
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values)
  VALUES (OLD.organization_id, OLD.business_id, auth.uid(), 'delete', 'proforma_invoice', OLD.id, OLD.proforma_number, to_jsonb(OLD));

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.proforma_items_block_converted_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_id uuid := COALESCE(NEW.proforma_invoice_id, OLD.proforma_invoice_id);
BEGIN
  SELECT status INTO v_status FROM public.proforma_invoices WHERE id = v_id;
  IF v_status = 'converted' THEN
    RAISE EXCEPTION 'Lines of a converted proforma are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_proforma_status_write_guard ON public.proforma_invoices;
CREATE TRIGGER trg_proforma_status_write_guard
  BEFORE UPDATE ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public.proforma_status_write_guard();

DROP TRIGGER IF EXISTS trg_proforma_freeze_after_convert ON public.proforma_invoices;
CREATE TRIGGER trg_proforma_freeze_after_convert
  BEFORE UPDATE ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public.proforma_freeze_after_convert();

DROP TRIGGER IF EXISTS trg_proforma_block_converted_delete ON public.proforma_invoices;
CREATE TRIGGER trg_proforma_block_converted_delete
  BEFORE DELETE ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public.proforma_block_converted_delete();

DROP TRIGGER IF EXISTS trg_proforma_items_block_converted_write ON public.proforma_invoice_items;
CREATE TRIGGER trg_proforma_items_block_converted_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.proforma_items_block_converted_write();

-- 6. Status state machine ---------------------------------------------
CREATE OR REPLACE FUNCTION public.set_proforma_status_atomic(
  p_proforma_id uuid,
  p_status text,
  p_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pf RECORD;
  v_auth uuid := auth.uid();
  v_jwt_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_user uuid;
  v_allowed text[];
BEGIN
  IF v_jwt_role = 'service_role' THEN
    v_user := p_user_id;
  ELSE
    IF v_auth IS NULL THEN
      RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_auth THEN
      RAISE EXCEPTION 'Caller identity mismatch' USING ERRCODE = '42501';
    END IF;
    v_user := v_auth;
  END IF;

  IF p_status = 'converted' THEN
    RAISE EXCEPTION 'Proformas become converted only through convert_proforma_to_invoice_atomic()'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pf FROM public.proforma_invoices WHERE id = p_proforma_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proforma % not found', p_proforma_id;
  END IF;

  IF v_jwt_role <> 'service_role'
     AND (v_user IS NULL OR NOT public.user_can_access_business(v_user, v_pf.business_id)) THEN
    RAISE EXCEPTION 'Access denied for business %' , v_pf.business_id USING ERRCODE = '42501';
  END IF;

  IF v_pf.converted_invoice_id IS NOT NULL OR v_pf.status = 'converted' THEN
    RAISE EXCEPTION 'Proforma % is already converted and its status is final', v_pf.proforma_number
      USING ERRCODE = '42501';
  END IF;

  IF v_pf.status = p_status THEN
    RETURN jsonb_build_object('success', true, 'status', p_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_pf.status
    WHEN 'draft'    THEN ARRAY['sent','cancelled']
    WHEN 'sent'     THEN ARRAY['accepted','rejected','expired','cancelled']
    WHEN 'accepted' THEN ARRAY['cancelled','expired']
    WHEN 'rejected' THEN ARRAY['cancelled']
    WHEN 'expired'  THEN ARRAY['sent','cancelled']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Illegal proforma transition % -> %', v_pf.status, p_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.proforma_status_writer', '1', true);
  UPDATE public.proforma_invoices
     SET status = p_status, updated_at = now()
   WHERE id = p_proforma_id;
  PERFORM set_config('app.proforma_status_writer', '0', true);

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values, new_values, changes_summary)
  VALUES (v_pf.organization_id, v_pf.business_id, v_user, 'status_change', 'proforma_invoice', p_proforma_id, v_pf.proforma_number,
          jsonb_build_object('status', v_pf.status), jsonb_build_object('status', p_status), p_reason);

  RETURN jsonb_build_object('success', true, 'status', p_status, 'from_status', v_pf.status);
END;
$$;

-- 7. Atomic create with server-side totals ------------------------------
CREATE OR REPLACE FUNCTION public.create_proforma_atomic(
  p_header jsonb,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := (p_header->>'organization_id')::uuid;
  v_business uuid := (p_header->>'business_id')::uuid;
  v_number text;
  v_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_discount numeric := 0;
  v_item jsonb;
  v_gross numeric;
  v_disc numeric;
  v_net numeric;
  v_line_tax numeric;
  v_sort int := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_has_module_permission(v_user, v_org, v_business, 'sales', 'manage') THEN
    RAISE EXCEPTION 'Sales permission required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = '22023';
  END IF;

  v_number := public.get_next_proforma_number(v_org, v_business);

  INSERT INTO public.proforma_invoices(
    organization_id, business_id, branch_id, contact_id, proforma_number,
    issue_date, expiry_date, status, currency,
    subtotal, tax_amount, discount_amount, total, notes, terms, created_by
  ) VALUES (
    v_org, v_business, NULLIF(p_header->>'branch_id','')::uuid, NULLIF(p_header->>'contact_id','')::uuid, v_number,
    COALESCE((p_header->>'issue_date')::date, CURRENT_DATE),
    COALESCE((p_header->>'expiry_date')::date, CURRENT_DATE + 30),
    'draft', COALESCE(NULLIF(p_header->>'currency',''), 'USD'),
    0, 0, 0, 0,
    NULLIF(p_header->>'notes',''), NULLIF(p_header->>'terms',''), v_user
  ) RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_gross := ROUND(COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_price')::numeric, 0), 2);
    v_disc := ROUND(v_gross * COALESCE((v_item->>'discount_percent')::numeric, 0) / 100, 2);
    v_net := v_gross - v_disc;
    v_line_tax := ROUND(v_net * COALESCE((v_item->>'tax_rate')::numeric, 0) / 100, 2);

    INSERT INTO public.proforma_invoice_items(
      proforma_invoice_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, discount_percent, line_total, sort_order
    ) VALUES (
      v_id, NULLIF(v_item->>'product_id','')::uuid, COALESCE(NULLIF(v_item->>'description',''), 'Item'),
      COALESCE((v_item->>'quantity')::numeric, 0), COALESCE((v_item->>'unit_price')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0), v_line_tax,
      COALESCE((v_item->>'discount_percent')::numeric, 0), v_net, v_sort
    );

    v_subtotal := v_subtotal + v_net;
    v_tax := v_tax + v_line_tax;
    v_discount := v_discount + v_disc;
    v_sort := v_sort + 1;
  END LOOP;

  UPDATE public.proforma_invoices
     SET subtotal = v_subtotal,
         tax_amount = v_tax,
         discount_amount = v_discount,
         total = v_subtotal + v_tax,
         updated_at = now()
   WHERE id = v_id;

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, new_values)
  VALUES (v_org, v_business, v_user, 'create', 'proforma_invoice', v_id, v_number,
          jsonb_build_object('total', v_subtotal + v_tax, 'status', 'draft'));

  RETURN jsonb_build_object('success', true, 'id', v_id, 'proforma_number', v_number,
                            'subtotal', v_subtotal, 'tax_amount', v_tax, 'total', v_subtotal + v_tax);
END;
$$;

-- 8. Converter: align guard with schema, bypass status trigger, audit ---
CREATE OR REPLACE FUNCTION public.convert_proforma_to_invoice_atomic(
  p_proforma_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pf RECORD;
  v_inv_number text;
  v_inv_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pf FROM public.proforma_invoices WHERE id = p_proforma_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proforma % not found', p_proforma_id; END IF;
  IF v_pf.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Proforma % already converted to invoice %', v_pf.proforma_number, v_pf.converted_invoice_id;
  END IF;
  IF v_pf.status NOT IN ('draft','sent','accepted') THEN
    RAISE EXCEPTION 'Cannot convert proforma in status %', v_pf.status;
  END IF;
  IF v_pf.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_pf.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_pf.business_id USING ERRCODE = '42501';
  END IF;

  SELECT public.get_next_invoice_number(v_pf.organization_id, v_pf.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, terms, created_by,
    source_proforma_invoice_id
  ) VALUES (
    v_pf.organization_id, v_pf.business_id, v_pf.branch_id, v_pf.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_pf.subtotal, v_pf.tax_amount, COALESCE(v_pf.discount_amount, 0), v_pf.total, v_pf.currency,
    v_pf.notes, v_pf.terms, p_user_id,
    p_proforma_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, pi.product_id, pi.description, pi.quantity, pi.unit_price,
    COALESCE(pi.tax_rate, 0), COALESCE(pi.tax_amount, 0),
    COALESCE(pi.discount_percent, 0), pi.line_total, pi.sort_order
  FROM public.proforma_invoice_items pi
  WHERE pi.proforma_invoice_id = p_proforma_id;

  PERFORM set_config('app.proforma_status_writer', '1', true);
  UPDATE public.proforma_invoices
     SET status = 'converted',
         converted_invoice_id = v_inv_id,
         converted_at = now(),
         updated_at = now()
   WHERE id = p_proforma_id;
  PERFORM set_config('app.proforma_status_writer', '0', true);

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, old_values, new_values, changes_summary)
  VALUES (v_pf.organization_id, v_pf.business_id, COALESCE(p_user_id, auth.uid()), 'convert', 'proforma_invoice',
          p_proforma_id, v_pf.proforma_number,
          jsonb_build_object('status', v_pf.status),
          jsonb_build_object('status', 'converted', 'invoice_id', v_inv_id, 'invoice_number', v_inv_number),
          'Converted to invoice ' || v_inv_number);

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number
  );
END;
$$;

-- 9. Expiry sweep -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_overdue_proformas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  PERFORM set_config('app.proforma_status_writer', '1', true);
  WITH upd AS (
    UPDATE public.proforma_invoices
       SET status = 'expired', updated_at = now()
     WHERE status = 'sent'
       AND expiry_date < CURRENT_DATE
       AND converted_invoice_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upd;
  PERFORM set_config('app.proforma_status_writer', '0', true);
  RETURN v_count;
END;
$$;

-- 10. RLS convergence ---------------------------------------------------
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies
           WHERE schemaname = 'public' AND tablename IN ('proforma_invoices','proforma_invoice_items')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proforma_invoice_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.proforma_invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.proforma_invoice_items TO authenticated;
GRANT ALL ON public.proforma_invoices TO service_role;
GRANT ALL ON public.proforma_invoice_items TO service_role;

CREATE POLICY proforma_invoices_select_v2 ON public.proforma_invoices
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view'));

CREATE POLICY proforma_invoices_insert_v2 ON public.proforma_invoices
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
     AND public.rls_check_org_can_write(organization_id));

CREATE POLICY proforma_invoices_update_v2 ON public.proforma_invoices
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
     AND public.rls_check_org_can_write(organization_id));

CREATE POLICY proforma_invoices_delete_v2 ON public.proforma_invoices
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage')
     AND public.rls_check_org_can_write(organization_id));

CREATE POLICY proforma_invoice_items_select_v2 ON public.proforma_invoice_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.proforma_invoices p
                 WHERE p.id = proforma_invoice_items.proforma_invoice_id
                   AND public.user_can_access_business(auth.uid(), p.business_id)
                   AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'sales', 'view')));

CREATE POLICY proforma_invoice_items_insert_v2 ON public.proforma_invoice_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.proforma_invoices p
                 WHERE p.id = proforma_invoice_items.proforma_invoice_id
                   AND public.user_can_access_business(auth.uid(), p.business_id)
                   AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'sales', 'manage')
                   AND public.rls_check_org_can_write(p.organization_id)));

CREATE POLICY proforma_invoice_items_update_v2 ON public.proforma_invoice_items
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.proforma_invoices p
                 WHERE p.id = proforma_invoice_items.proforma_invoice_id
                   AND public.user_can_access_business(auth.uid(), p.business_id)
                   AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'sales', 'manage')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.proforma_invoices p
                 WHERE p.id = proforma_invoice_items.proforma_invoice_id
                   AND public.user_can_access_business(auth.uid(), p.business_id)
                   AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'sales', 'manage')
                   AND public.rls_check_org_can_write(p.organization_id)));

CREATE POLICY proforma_invoice_items_delete_v2 ON public.proforma_invoice_items
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.proforma_invoices p
                 WHERE p.id = proforma_invoice_items.proforma_invoice_id
                   AND public.user_can_access_business(auth.uid(), p.business_id)
                   AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'sales', 'manage')
                   AND public.rls_check_org_can_write(p.organization_id)));

REVOKE ALL ON FUNCTION public.create_proforma_atomic(jsonb, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.set_proforma_status_atomic(uuid, text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.get_next_proforma_number(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_proforma_atomic(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_proforma_status_atomic(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_next_proforma_number(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_overdue_proformas() TO service_role;