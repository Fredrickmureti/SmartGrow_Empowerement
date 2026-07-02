CREATE OR REPLACE FUNCTION public.get_default_account_id(
  _org_id uuid,
  _business_id uuid,
  _setting_key text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id
  FROM public.default_account_settings
  WHERE organization_id = _org_id
    AND setting_key = _setting_key
    AND (business_id = _business_id OR business_id IS NULL)
  ORDER BY business_id NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_shift            RECORD;
  v_org_id           uuid;
  v_business_id      uuid;
  v_cash_account     uuid;
  v_revenue_account  uuid;
  v_tax_account      uuid;
  v_total_sales      numeric := 0;
  v_total_tax        numeric := 0;
  v_total_net        numeric := 0;
  v_shift_date       date;
  v_reference        text;
  v_entry_number     text;
  v_lines            jsonb;
  v_jeid             uuid;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS shift not found: %', _shift_id;
  END IF;

  v_org_id      := v_shift.organization_id;
  v_business_id := v_shift.business_id;
  v_shift_date  := COALESCE(v_shift.closed_at, v_shift.created_at, now())::date;
  v_reference   := 'POS-SHIFT-' || COALESCE(v_shift.shift_number, _shift_id::text);

  SELECT
    COALESCE(SUM(total), 0),
    COALESCE(SUM(tax_amount), 0),
    COALESCE(SUM(subtotal), 0)
  INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id
    AND transaction_type = 'sale'
    AND status = 'completed';

  IF v_total_sales = 0 THEN
    RETURN NULL;
  END IF;

  v_cash_account    := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
  IF v_cash_account IS NULL THEN
    v_cash_account  := public.get_default_account_id(v_org_id, v_business_id, 'cash');
  END IF;
  v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN
    v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue');
  END IF;
  v_tax_account     := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
  IF v_tax_account IS NULL THEN
    v_tax_account   := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable');
  END IF;
  IF v_tax_account IS NULL THEN
    v_tax_account   := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable');
  END IF;

  IF v_cash_account IS NULL OR v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing default account mapping. Configure ''pos_cash'' (or ''cash'') and ''pos_revenue'' (or ''sales_revenue'') in Settings > Default Accounts. shift_id=%', _shift_id;
  END IF;

  IF v_total_tax > 0 AND v_tax_account IS NULL THEN
    RAISE EXCEPTION 'POS shift has tax of % but no tax-payable account is mapped. Configure ''pos_tax_payable'' or ''tax_payable'' in Settings > Default Accounts.', v_total_tax;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_cash_account,
      'debit',  v_total_sales,
      'credit', 0,
      'description', 'POS Cash/Card Receipts'
    ),
    jsonb_build_object(
      'account_id', v_revenue_account,
      'debit',  0,
      'credit', v_total_net,
      'description', 'POS Sales Revenue'
    )
  );
  IF v_total_tax > 0 AND v_tax_account IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_tax_account,
        'debit',  0,
        'credit', v_total_tax,
        'description', 'POS Sales Tax Collected'
      )
    );
  END IF;

  SELECT COALESCE(
    'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
    'JE-00001'
  ) INTO v_entry_number
  FROM public.journal_entries WHERE organization_id = v_org_id;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id,
    v_business_id,
    v_entry_number,
    v_shift_date,
    v_reference,
    'POS Shift Close - aggregated GL posting',
    'pos_shift',
    _shift_id,
    v_shift.closed_by,
    false,
    false,
    v_lines,
    NULL,
    NULL,
    'main'
  );

  BEGIN
    UPDATE public.pos_shifts
    SET journal_entry_id = v_jeid,
        gl_posted_at = COALESCE(gl_posted_at, now())
    WHERE id = _shift_id;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  RETURN v_jeid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_pos_shift_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jeid uuid;
BEGIN
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  v_jeid := public.post_pos_shift_gl(NEW.id);
  IF v_jeid IS NOT NULL THEN
    NEW.journal_entry_id := v_jeid;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replay_pos_shift_gl(_shift_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_shift RECORD;
  v_jeid uuid;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS shift not found: %', _shift_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id = v_shift.organization_id
      AND COALESCE(is_active, true)
  ) THEN
    RAISE EXCEPTION 'Not authorized to replay GL for this shift.';
  END IF;

  v_jeid := public.post_pos_shift_gl(_shift_id);
  RETURN v_jeid;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.replay_pos_shift_gl(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_default_account_id(uuid, uuid, text) TO authenticated;