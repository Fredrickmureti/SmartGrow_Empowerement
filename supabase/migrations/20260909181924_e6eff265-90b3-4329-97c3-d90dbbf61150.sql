CREATE OR REPLACE FUNCTION public.close_branch_day(
  p_day_id uuid,
  p_counted_cash numeric,
  p_variance_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d           record;
  b           record;
  v_expected  numeric;
  v_counted   numeric := ROUND(COALESCE(p_counted_cash, 0), 2);
  v_variance  numeric;
  v_open_batches integer;
  v_cash_acc  uuid;
  v_os_acc    uuid;
  v_je        uuid;
  v_lines     jsonb;
  v_desc      text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('branch_day:' || p_day_id::text));

  SELECT * INTO d FROM public.branch_operational_days WHERE id = p_day_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch day % not found', p_day_id; END IF;
  IF d.status <> 'open' THEN
    RAISE EXCEPTION 'This day is already closed';
  END IF;

  SELECT br.id, br.name, br.day_variance_tolerance INTO b
  FROM public.branches br WHERE br.id = d.branch_id;

  IF NOT public.mf_can_scoped(d.business_id, d.branch_id, 'treasury', 'close') THEN
    RAISE EXCEPTION 'You do not have permission to close the day at %', b.name;
  END IF;

  SELECT count(*) INTO v_open_batches
  FROM public.mf_repayment_batches rb
  WHERE rb.branch_id = d.branch_id
    AND rb.collected_on = d.business_date
    AND rb.status <> 'closed';
  IF v_open_batches > 0 THEN
    RAISE EXCEPTION 'Close the % collection round(s) still open for % before closing the day',
      v_open_batches, d.business_date;
  END IF;

  v_expected := public.branch_day_expected_cash(p_day_id);
  v_variance := ROUND(v_counted - v_expected, 2);

  IF v_variance <> 0 THEN
    IF COALESCE(btrim(p_variance_reason), '') = '' THEN
      RAISE EXCEPTION 'A cash difference of % needs a reason', v_variance;
    END IF;
    IF abs(v_variance) > COALESCE(b.day_variance_tolerance, 0)
       AND NOT public.mf_can_scoped(d.business_id, d.branch_id, 'treasury', 'admin_override') THEN
      RAISE EXCEPTION 'A cash difference of % is above the branch tolerance and needs a manager to close the day', v_variance;
    END IF;

    v_cash_acc := public.mf_resolve_account(d.business_id, d.branch_id, 'cash');
    v_os_acc   := public.mf_resolve_account(d.business_id, d.branch_id, 'cash_over_short');
    v_desc := format('Cash %s at %s on %s: %s',
                     CASE WHEN v_variance > 0 THEN 'over' ELSE 'short' END,
                     b.name, d.business_date, p_variance_reason);

    IF v_variance > 0 THEN
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cash_acc, 'debit', v_variance, 'credit', 0, 'description', v_desc),
        jsonb_build_object('account_id', v_os_acc, 'debit', 0, 'credit', v_variance, 'description', v_desc));
    ELSE
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_os_acc, 'debit', abs(v_variance), 'credit', 0, 'description', v_desc),
        jsonb_build_object('account_id', v_cash_acc, 'debit', 0, 'credit', abs(v_variance), 'description', v_desc));
    END IF;

    v_je := public.post_journal_entry_atomic(
      _org_id => d.organization_id,
      _business_id => d.business_id,
      _entry_number => NULL,
      _entry_date => d.business_date,
      _reference => format('DAY-%s', to_char(d.business_date, 'YYYYMMDD')),
      _description => v_desc,
      _source_type => 'branch_day_close',
      _source_id => d.id,
      _created_by => auth.uid(),
      _is_closing => false,
      _is_adjusting => false,
      _lines => v_lines,
      _currency => (SELECT bu.base_currency FROM public.businesses bu WHERE bu.id = d.business_id),
      _exchange_rate => 1::numeric,
      _source_subtype => 'cash_variance',
      _branch_id => d.branch_id,
      _is_opening_entry => false,
      _amounts_in_document_currency => false);
  END IF;

  UPDATE public.branch_operational_days
     SET status = 'closed',
         expected_cash = v_expected,
         counted_cash = v_counted,
         variance = v_variance,
         variance_reason = NULLIF(btrim(COALESCE(p_variance_reason, '')), ''),
         variance_journal_entry_id = v_je,
         notes = COALESCE(p_notes, notes),
         closed_by = auth.uid(),
         closed_at = now()
   WHERE id = p_day_id;

  INSERT INTO public.branch_day_events (
    organization_id, business_id, branch_id, operational_day_id, business_date,
    event_type, actor_id, opening_cash, expected_cash, counted_cash, variance, reason
  ) VALUES (
    d.organization_id, d.business_id, d.branch_id, d.id, d.business_date,
    'closed', auth.uid(), d.opening_cash, v_expected, v_counted, v_variance, p_variance_reason
  );

  RETURN p_day_id;
END;
$$;

REVOKE ALL ON FUNCTION public.close_branch_day(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_branch_day(uuid, numeric, text, text) TO authenticated;