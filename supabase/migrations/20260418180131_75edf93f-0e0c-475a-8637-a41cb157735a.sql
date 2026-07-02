-- 1. Trigger gates: early-return when an authorized org reset is in progress for this org

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_lines_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  parent_status TEXT;
  parent_org_id UUID;
  reset_org TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status, organization_id INTO parent_status, parent_org_id
    FROM public.journal_entries
    WHERE id = OLD.journal_entry_id;

    -- Bypass during privileged org reset for the matching org
    IF reset_org IS NOT NULL AND reset_org <> '' AND parent_org_id::text = reset_org THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;

    IF parent_status IN ('posted', 'voided') THEN
      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status, organization_id INTO parent_status, parent_org_id
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;

    IF reset_org IS NOT NULL AND reset_org <> '' AND parent_org_id::text = reset_org THEN
      RETURN NEW;
    END IF;

    IF parent_status IN ('posted', 'voided') THEN
      IF TG_OP = 'INSERT' AND parent_status = 'posted' THEN
        DECLARE
          parent_created_at TIMESTAMPTZ;
        BEGIN
          SELECT created_at INTO parent_created_at
          FROM public.journal_entries
          WHERE id = NEW.journal_entry_id;

          IF parent_created_at > NOW() - INTERVAL '30 seconds' THEN
            RETURN NEW;
          END IF;
        END;
      END IF;

      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  reset_org TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status NOT IN ('posted', 'voided', 'reversed') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('voided', 'reversed') THEN
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.source_subtype IS DISTINCT FROM OLD.source_subtype
       OR NEW.is_adjusting IS DISTINCT FROM OLD.is_adjusting
       OR NEW.is_closing IS DISTINCT FROM OLD.is_closing
       OR NEW.is_reversing IS DISTINCT FROM OLD.is_reversing
       OR NEW.is_reversal IS DISTINCT FROM OLD.is_reversal
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
       OR NEW.reversed_entry_id IS DISTINCT FROM OLD.reversed_entry_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
    THEN
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding/reversing bookkeeping fields are allowed.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('voided', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_fiscal_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    entry_date DATE;
    entry_org_id UUID;
    entry_biz_id UUID;
    locked_period RECORD;
    reset_org TEXT;
BEGIN
    SELECT je.entry_date, je.organization_id, je.business_id
    INTO entry_date, entry_org_id, entry_biz_id
    FROM public.journal_entries je
    WHERE je.id = NEW.journal_entry_id;

    reset_org := current_setting('app.reset_in_progress', true);
    IF reset_org IS NOT NULL AND reset_org <> '' AND entry_org_id::text = reset_org THEN
      RETURN NEW;
    END IF;

    SELECT fp.id, fp.name INTO locked_period
    FROM public.fiscal_periods fp
    WHERE fp.organization_id = entry_org_id
    AND fp.status = 'closed'
    AND entry_date BETWEEN fp.start_date AND fp.end_date
    AND (fp.business_id = entry_biz_id OR fp.business_id IS NULL)
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'Cannot post to closed fiscal period: %', locked_period.name;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_account_balance_on_je_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  _account_type text;
  _je_status text;
  _je_org_id uuid;
  _debit numeric;
  _credit numeric;
  reset_org text;
BEGIN
  SELECT status, organization_id INTO _je_status, _je_org_id
  FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> '' AND _je_org_id::text = reset_org THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF _je_status IS DISTINCT FROM 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT account_type::text INTO _account_type
  FROM public.accounts
  WHERE id = COALESCE(NEW.account_id, OLD.account_id);

  IF TG_OP = 'INSERT' THEN
    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = NEW.account_id;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = OLD.account_id;
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);
    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END
    WHERE id = OLD.account_id;

    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);
    SELECT account_type::text INTO _account_type
    FROM public.accounts WHERE id = NEW.account_id;
    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit ELSE _credit - _debit END,
      updated_at = now()
    WHERE id = NEW.account_id;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_balances_on_je_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  reset_org text;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance - (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance + (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_automation_processor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  payload jsonb;
  record_data jsonb;
  old_record_data jsonb;
  org_id text;
  event_type text;
  rec_id text;
  changed_fields jsonb;
  edge_function_url text;
  anon_key text;
  reset_org text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    org_id := OLD.organization_id::text;
  ELSE
    org_id := NEW.organization_id::text;
  END IF;

  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> '' AND org_id = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    record_data := to_jsonb(OLD);
    old_record_data := to_jsonb(OLD);
  ELSIF TG_OP = 'UPDATE' THEN
    record_data := to_jsonb(NEW);
    old_record_data := to_jsonb(OLD);
  ELSE
    record_data := to_jsonb(NEW);
    old_record_data := NULL;
  END IF;

  CASE TG_OP
    WHEN 'INSERT' THEN event_type := 'on_create';
    WHEN 'UPDATE' THEN event_type := 'on_update';
    WHEN 'DELETE' THEN event_type := 'on_delete';
    ELSE event_type := lower(TG_OP);
  END CASE;

  IF TG_OP = 'DELETE' THEN
    rec_id := OLD.id::text;
  ELSE
    rec_id := NEW.id::text;
  END IF;

  IF org_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  changed_fields := '[]'::jsonb;
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(jsonb_agg(field_name), '[]'::jsonb) INTO changed_fields
    FROM (
      SELECT COALESCE(n.key, o.key) AS field_name
      FROM jsonb_each_text(to_jsonb(NEW)) AS n(key, val)
      FULL OUTER JOIN jsonb_each_text(to_jsonb(OLD)) AS o(key, val) ON n.key = o.key
      WHERE n.val IS DISTINCT FROM o.val
    ) changed;
  END IF;

  payload := jsonb_build_object(
    'event_type', event_type,
    'target_model', TG_TABLE_NAME,
    'record_id', rec_id,
    'record_data', record_data,
    'old_data', old_record_data,
    'changed_fields', changed_fields,
    'organization_id', org_id
  );

  edge_function_url := rtrim(current_setting('app.settings.supabase_url', true), '/') || '/functions/v1/process-automation';
  anon_key := current_setting('app.settings.supabase_anon_key', true);

  IF edge_function_url IS NULL OR edge_function_url = '' OR edge_function_url = '/functions/v1/process-automation' THEN
    edge_function_url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-automation';
  END IF;

  IF anon_key IS NULL OR anon_key = '' THEN
    anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
  END IF;

  PERFORM net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := payload
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

-- 2. Reset orchestrators set the per-transaction marker after permission/token check

CREATE OR REPLACE FUNCTION public.reset_organization_data(org_id uuid, confirmation_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_residual jsonb;
  v_residual_total bigint := 0;
  v_expected_token text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  -- Privileged reset marker (per-transaction; auto-cleared at COMMIT/ROLLBACK)
  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks',  public.reset_module__unlink_audit_refs(org_id));
  v_counts := v_counts || jsonb_build_object('pos',            public.reset_module__pos(org_id));
  v_counts := v_counts || jsonb_build_object('inventory',      public.reset_module__inventory(org_id));
  v_counts := v_counts || jsonb_build_object('fixed_assets',   public.reset_module__fixed_assets(org_id));
  v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
  v_counts := v_counts || jsonb_build_object('ancillaries',    public.reset_module__ancillaries(org_id));
  v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
  v_counts := v_counts || jsonb_build_object('banking',        public.reset_module__banking(org_id));
  v_counts := v_counts || jsonb_build_object('sales',          public.reset_module__sales(org_id));
  v_counts := v_counts || jsonb_build_object('purchases',      public.reset_module__purchases(org_id));
  v_counts := v_counts || jsonb_build_object('finance',        public.reset_module__finance(org_id));
  v_counts := v_counts || jsonb_build_object('sequences',      public.reset_module__sequences(org_id));

  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'bills', count(*) FROM bills WHERE organization_id=org_id UNION ALL
    SELECT 'payments', count(*) FROM payments WHERE organization_id=org_id UNION ALL
    SELECT 'bill_payments', count(*) FROM bill_payments WHERE organization_id=org_id UNION ALL
    SELECT 'expenses', count(*) FROM expenses WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries', count(*) FROM journal_entries WHERE organization_id=org_id UNION ALL
    SELECT 'bank_transactions', count(*) FROM bank_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'credit_notes', count(*) FROM credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_returns', count(*) FROM sales_returns WHERE organization_id=org_id UNION ALL
    SELECT 'delivery_notes', count(*) FROM delivery_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_orders', count(*) FROM sales_orders WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_orders', count(*) FROM purchase_orders WHERE organization_id=org_id UNION ALL
    SELECT 'proforma_invoices', count(*) FROM proforma_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'estimates', count(*) FROM estimates WHERE organization_id=org_id UNION ALL
    SELECT 'recurring_invoices', count(*) FROM recurring_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'transactions', count(*) FROM transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions', count(*) FROM pos_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_shifts', count(*) FROM pos_shifts WHERE organization_id=org_id UNION ALL
    SELECT 'pos_held_transactions', count(*) FROM pos_held_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_table_sessions', count(*) FROM pos_table_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'stock_movements', count(*) FROM stock_movements WHERE organization_id=org_id UNION ALL
    SELECT 'stock_adjustments', count(*) FROM stock_adjustments WHERE organization_id=org_id UNION ALL
    SELECT 'goods_receipts', count(*) FROM goods_receipts WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries', count(*) FROM depreciation_entries WHERE organization_id=org_id UNION ALL
    SELECT 'vendor_credit_notes', count(*) FROM vendor_credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_returns', count(*) FROM purchase_returns WHERE organization_id=org_id UNION ALL
    SELECT 'bank_reconciliation_sessions', count(*) FROM bank_reconciliation_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'bank_statements', count(*) FROM bank_statements WHERE organization_id=org_id
  ) s;

  IF v_residual_total > 0 THEN
    RAISE EXCEPTION 'Reset coverage check failed — residual transactional rows: %', v_residual::text
      USING ERRCODE='23000';
  END IF;

  WITH leaves AS (
    SELECT (jsonb_each(module_obj.value)).value AS v
    FROM jsonb_each(v_counts) module_obj
    WHERE jsonb_typeof(module_obj.value) = 'object'
  )
  SELECT coalesce(sum((v)::bigint), 0) INTO v_total FROM leaves;

  RETURN jsonb_build_object(
    'success', true,
    'totalDeleted', v_total,
    'details', v_counts,
    'coverage_check', 'passed'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_categories(org_id uuid, categories text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  cat text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  IF categories IS NULL OR cardinality(categories) = 0 THEN
    RAISE EXCEPTION 'No categories provided' USING ERRCODE='22023';
  END IF;

  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks', public.reset_module__unlink_audit_refs(org_id));

  FOREACH cat IN ARRAY categories LOOP
    IF cat = 'pos' THEN
      v_counts := v_counts || jsonb_build_object('pos', public.reset_module__pos(org_id));
    ELSIF cat = 'inventory' THEN
      v_counts := v_counts || jsonb_build_object('inventory', public.reset_module__inventory(org_id));
    ELSIF cat = 'fixed_assets' THEN
      v_counts := v_counts || jsonb_build_object('fixed_assets', public.reset_module__fixed_assets(org_id));
    ELSIF cat = 'vendor_returns' THEN
      v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
    ELSIF cat = 'ancillaries' THEN
      v_counts := v_counts || jsonb_build_object('ancillaries', public.reset_module__ancillaries(org_id));
    ELSIF cat = 'banking' THEN
      v_counts := v_counts || jsonb_build_object('banking', public.reset_module__banking(org_id));
    ELSIF cat = 'transactions_ledger' THEN
      v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
    ELSIF cat = 'sales' THEN
      v_counts := v_counts || jsonb_build_object('sales', public.reset_module__sales(org_id));
    ELSIF cat = 'purchases' THEN
      v_counts := v_counts || jsonb_build_object('purchases', public.reset_module__purchases(org_id));
    ELSIF cat = 'finance' THEN
      v_counts := v_counts || jsonb_build_object('finance', public.reset_module__finance(org_id));
    ELSIF cat = 'sequences' THEN
      v_counts := v_counts || jsonb_build_object('sequences', public.reset_module__sequences(org_id));
    ELSE
      RAISE EXCEPTION 'Unknown category: %', cat USING ERRCODE='22023';
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'details', v_counts);
END;
$function$;

-- 3. Finance module: zero account balances at end (since balance trigger is bypassed during reset)

CREATE OR REPLACE FUNCTION public.reset_module__finance(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  UPDATE journal_entries
     SET reversed_entry_id = NULL
   WHERE organization_id = org_id
     AND reversed_entry_id IS NOT NULL;

  WITH d AS (DELETE FROM journal_entry_lines
              WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entry_lines', n);

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entries', n);

  -- Reconcile account balances since the line-trigger that maintains them was bypassed
  WITH u AS (
    UPDATE accounts
       SET current_balance = 0, updated_at = now()
     WHERE organization_id = org_id AND current_balance IS DISTINCT FROM 0
     RETURNING 1
  ) SELECT count(*) INTO n FROM u;
  v := v || jsonb_build_object('accounts_balance_zeroed', n);

  RETURN v;
END;
$function$;