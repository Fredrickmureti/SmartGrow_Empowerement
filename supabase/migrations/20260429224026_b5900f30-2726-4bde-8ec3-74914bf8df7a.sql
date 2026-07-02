
-- ============================================================================
-- SMS Stage C: enrich event variables, add missing event triggers, fix resolver
-- ============================================================================

-- ── 1. Helper: build common variables for any sales/finance document ──
CREATE OR REPLACE FUNCTION public.sms_build_doc_vars(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_contact_id uuid,
  p_doc_number text,
  p_amount numeric,
  p_currency text,
  p_due_date date,
  p_extra jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_customer_name text;
  v_company_name  text;
  v_org_name      text;
  v_branch_name   text;
BEGIN
  IF p_contact_id IS NOT NULL THEN
    SELECT name INTO v_customer_name FROM public.contacts WHERE id = p_contact_id;
  END IF;
  IF p_business_id IS NOT NULL THEN
    SELECT name INTO v_company_name FROM public.businesses WHERE id = p_business_id;
  END IF;
  IF p_org_id IS NOT NULL THEN
    SELECT name INTO v_org_name FROM public.organizations WHERE id = p_org_id;
  END IF;
  IF p_branch_id IS NOT NULL THEN
    SELECT name INTO v_branch_name FROM public.branches WHERE id = p_branch_id;
  END IF;

  RETURN COALESCE(p_extra, '{}'::jsonb) || jsonb_build_object(
    'customer_name', COALESCE(v_customer_name, ''),
    'company_name',  COALESCE(v_company_name, v_org_name, ''),
    'org_name',      COALESCE(v_org_name, ''),
    'branch_name',   COALESCE(v_branch_name, ''),
    'document_number', COALESCE(p_doc_number, ''),
    'amount',        COALESCE(p_amount::text, ''),
    'currency',      COALESCE(p_currency, ''),
    'due_date',      COALESCE(p_due_date::text, ''),
    'payment_link',  '' -- reserved, future
  );
END;
$$;

-- ── 2. Rewrite existing trigger functions with rich vars ──

CREATE OR REPLACE FUNCTION public.trg_sms_invoice_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_vars jsonb;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('posted','sent','open','authorised'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('posted','sent','open','authorised')
         AND COALESCE(OLD.status::text,'') NOT IN ('posted','sent','open','authorised')) THEN
    v_vars := public.sms_build_doc_vars(
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.contact_id,
      NEW.invoice_number, NEW.total, NEW.currency, NEW.due_date,
      jsonb_build_object('invoice_number', COALESCE(NEW.invoice_number,''))
    );
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'invoice_posted'::sms_event_type,
      'invoice', NEW.id, NEW.contact_id, v_vars
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_invoice_posted failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sms_sales_order_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_vars jsonb;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('confirmed','approved','sent'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('confirmed','approved','sent')
         AND COALESCE(OLD.status::text,'') NOT IN ('confirmed','approved','sent')) THEN
    v_vars := public.sms_build_doc_vars(
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.contact_id,
      NULL, NEW.total, NEW.currency, NULL
    );
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'sales_order_confirmed'::sms_event_type,
      'sales_order', NEW.id, NEW.contact_id, v_vars
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_sales_order_confirmed failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sms_estimate_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_vars jsonb;
BEGIN
  IF (TG_OP = 'UPDATE' AND NEW.status::text IN ('sent','accepted')
      AND COALESCE(OLD.status::text,'') NOT IN ('sent','accepted')) THEN
    v_vars := public.sms_build_doc_vars(
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.contact_id,
      NEW.estimate_number, NEW.total, NEW.currency, NEW.expiry_date,
      jsonb_build_object('estimate_number', COALESCE(NEW.estimate_number,''))
    );
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'estimate_sent'::sms_event_type,
      'estimate', NEW.id, NEW.contact_id, v_vars
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_estimate_sent failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sms_credit_note_issued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_vars jsonb;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('issued','posted','sent','applied'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('issued','posted','sent','applied')
         AND COALESCE(OLD.status::text,'') NOT IN ('issued','posted','sent','applied')) THEN
    v_vars := public.sms_build_doc_vars(
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.contact_id,
      NEW.credit_note_number, NEW.total, NEW.currency, NULL,
      jsonb_build_object('credit_note_number', COALESCE(NEW.credit_note_number,''))
    );
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'credit_note_issued'::sms_event_type,
      'credit_note', NEW.id, NEW.contact_id, v_vars
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_credit_note_issued failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sms_delivery_shipped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_vars jsonb;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status IN ('shipped','sent','delivered'))
     OR (TG_OP = 'UPDATE' AND NEW.status IN ('shipped','sent','delivered')
         AND COALESCE(OLD.status,'') NOT IN ('shipped','sent','delivered')) THEN
    v_vars := public.sms_build_doc_vars(
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.contact_id,
      NULL, NULL, NULL, NULL
    );
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'delivery_shipped'::sms_event_type,
      'delivery_note', NEW.id, NEW.contact_id, v_vars
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_delivery_shipped failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- ── 3. NEW: payment_received trigger on payments table ──
CREATE OR REPLACE FUNCTION public.trg_sms_payment_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_vars jsonb;
  v_invoice_number text;
  v_currency text;
BEGIN
  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status::text IN ('succeeded','completed','paid','received'))
    OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('succeeded','completed','paid','received')
        AND COALESCE(OLD.status::text,'') NOT IN ('succeeded','completed','paid','received'))
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT invoice_number, currency INTO v_invoice_number, v_currency
    FROM public.invoices WHERE id = NEW.invoice_id;
  END IF;

  v_vars := public.sms_build_doc_vars(
    NEW.organization_id, NEW.business_id, NULL, NEW.contact_id,
    v_invoice_number, NEW.amount, v_currency, NULL,
    jsonb_build_object(
      'invoice_number', COALESCE(v_invoice_number,''),
      'reference',      COALESCE(NEW.reference,''),
      'payment_date',   COALESCE(NEW.payment_date::text, '')
    )
  );

  PERFORM public.sms_enqueue_event(
    NEW.organization_id, NEW.business_id, 'payment_received'::sms_event_type,
    'payment', NEW.id, NEW.contact_id, v_vars
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_payment_received failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_payment_received_trg ON public.payments;
CREATE TRIGGER sms_payment_received_trg
AFTER INSERT OR UPDATE OF status ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_payment_received();

-- ── 4. NEW: invoice_overdue scanner (idempotent, called by cron) ──
CREATE OR REPLACE FUNCTION public.sms_scan_overdue_invoices()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inv RECORD;
  v_vars jsonb;
  v_count int := 0;
BEGIN
  FOR v_inv IN
    SELECT i.*
    FROM public.invoices i
    WHERE i.due_date IS NOT NULL
      AND i.due_date < CURRENT_DATE
      AND i.status::text IN ('posted','sent','open','authorised','partial')
      AND NOT EXISTS (
        SELECT 1 FROM public.sms_event_outbox o
        WHERE o.entity_type = 'invoice'
          AND o.entity_id = i.id
          AND o.event_type = 'invoice_overdue'
      )
  LOOP
    v_vars := public.sms_build_doc_vars(
      v_inv.organization_id, v_inv.business_id, v_inv.branch_id, v_inv.contact_id,
      v_inv.invoice_number, v_inv.total, v_inv.currency, v_inv.due_date,
      jsonb_build_object(
        'invoice_number', COALESCE(v_inv.invoice_number,''),
        'days_overdue',   (CURRENT_DATE - v_inv.due_date)::text
      )
    );
    PERFORM public.sms_enqueue_event(
      v_inv.organization_id, v_inv.business_id, 'invoice_overdue'::sms_event_type,
      'invoice', v_inv.id, v_inv.contact_id, v_vars
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── 5. Fix resolve_rule_recipients no-op loop ──
CREATE OR REPLACE FUNCTION public.resolve_rule_recipients(
  p_org_id uuid,
  p_event sms_event_type,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_primary_contact_id uuid DEFAULT NULL,
  p_primary_phone text DEFAULT NULL
)
RETURNS TABLE(phone text, recipient_kind text, source text, contact_id uuid, user_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rule_id uuid;
  v_rule_recipient_type public.sms_recipient_type;
BEGIN
  SELECT r.id, r.recipient_type
    INTO v_rule_id, v_rule_recipient_type
  FROM public.sms_event_rules r
  WHERE r.organization_id = p_org_id
    AND r.event_type = p_event
    AND r.is_enabled = true
  LIMIT 1;

  IF v_rule_id IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _rcpt(
    phone text, recipient_kind text, source text, contact_id uuid, user_id uuid, is_fallback boolean
  ) ON COMMIT DROP;
  TRUNCATE _rcpt;

  -- ── Primary recipient ──
  IF p_primary_phone IS NOT NULL AND length(trim(p_primary_phone)) > 0 THEN
    INSERT INTO _rcpt VALUES (p_primary_phone, v_rule_recipient_type::text, 'primary_override', p_primary_contact_id, NULL, false);
  ELSIF v_rule_recipient_type IN ('customer','vendor') AND p_primary_contact_id IS NOT NULL THEN
    INSERT INTO _rcpt
    SELECT c.phone, v_rule_recipient_type::text, 'primary_contact', c.id, NULL, false
    FROM public.contacts c
    WHERE c.id = p_primary_contact_id
      AND c.phone IS NOT NULL
      AND COALESCE(c.sms_consent, true) = true;
  ELSIF v_rule_recipient_type = 'employee' AND p_primary_contact_id IS NOT NULL THEN
    INSERT INTO _rcpt
    SELECT COALESCE(e.personal_phone, e.phone), 'employee', 'primary_employee', NULL, NULL, false
    FROM public.employees e
    WHERE e.id = p_primary_contact_id
      AND COALESCE(e.personal_phone, e.phone) IS NOT NULL
      AND COALESCE(e.sms_consent, true) = true;
  ELSIF v_rule_recipient_type = 'internal' THEN
    INSERT INTO _rcpt
    SELECT p.phone, 'internal', 'primary_internal', NULL, ur.user_id, false
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.organization_id = p_org_id
      AND ur.is_active = true
      AND ur.role IN ('owner','admin')
      AND p.phone IS NOT NULL;
  END IF;

  -- ── Additional rule recipients (no useless FOR loop) ──
  INSERT INTO _rcpt
  SELECT rr.phone, 'phone', 'rule_phone', NULL, NULL, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'phone' AND rr.phone IS NOT NULL;

  INSERT INTO _rcpt
  SELECT p.phone, 'user', 'rule_user', NULL, p.id, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  JOIN public.profiles p ON p.id = rr.user_id
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'user' AND p.phone IS NOT NULL;

  INSERT INTO _rcpt
  SELECT p.phone, 'role', 'rule_role:' || rr.role::text, NULL, ur.user_id, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  JOIN public.user_roles ur ON ur.role = rr.role AND ur.organization_id = p_org_id AND ur.is_active = true
  JOIN public.profiles p ON p.id = ur.user_id
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'role' AND p.phone IS NOT NULL;

  INSERT INTO _rcpt
  SELECT m.phone, 'group_phone', 'rule_group:' || g.name, NULL, NULL, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  JOIN public.sms_recipient_groups g ON g.id = rr.group_id
  JOIN public.sms_recipient_group_members m ON m.group_id = g.id
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
    AND m.member_kind = 'phone' AND m.phone IS NOT NULL;

  INSERT INTO _rcpt
  SELECT p.phone, 'group_user', 'rule_group:' || g.name, NULL, p.id, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  JOIN public.sms_recipient_groups g ON g.id = rr.group_id
  JOIN public.sms_recipient_group_members m ON m.group_id = g.id
  JOIN public.profiles p ON p.id = m.user_id
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
    AND m.member_kind = 'user' AND p.phone IS NOT NULL;

  INSERT INTO _rcpt
  SELECT p.phone, 'group_role', 'rule_group:' || g.name || ':' || m.role::text, NULL, ur.user_id, rr.is_fallback
  FROM public.sms_event_rule_recipients rr
  JOIN public.sms_recipient_groups g ON g.id = rr.group_id
  JOIN public.sms_recipient_group_members m ON m.group_id = g.id
  JOIN public.user_roles ur ON ur.role = m.role AND ur.organization_id = p_org_id AND ur.is_active = true
  JOIN public.profiles p ON p.id = ur.user_id
  WHERE rr.rule_id = v_rule_id AND rr.recipient_kind = 'group'
    AND m.member_kind = 'role' AND p.phone IS NOT NULL;

  IF (SELECT count(*) FROM _rcpt WHERE is_fallback = false) > 0 THEN
    DELETE FROM _rcpt WHERE is_fallback = true;
  END IF;

  DELETE FROM _rcpt
  WHERE phone IN (SELECT phone_number FROM public.sms_opt_outs WHERE organization_id = p_org_id);

  RETURN QUERY
  SELECT DISTINCT ON (r.phone) r.phone, r.recipient_kind, r.source, r.contact_id, r.user_id
  FROM _rcpt r
  WHERE r.phone IS NOT NULL AND length(trim(r.phone)) > 0
  ORDER BY r.phone, r.is_fallback ASC;
END;
$$;

-- ── 6. Schedule daily overdue scan via pg_cron ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('sms-scan-overdue-invoices')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sms-scan-overdue-invoices');
    PERFORM cron.schedule(
      'sms-scan-overdue-invoices',
      '0 9 * * *', -- 09:00 daily
      $cron$ SELECT public.sms_scan_overdue_invoices(); $cron$
    );
  END IF;
END $$;
