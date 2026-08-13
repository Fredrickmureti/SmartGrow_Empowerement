CREATE OR REPLACE FUNCTION public.fx_exposure_by_currency(_business_id uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _base text;
  _rows jsonb := '[]'::jsonb;
  _missing jsonb := '[]'::jsonb;
  _row record;
  _r record;
BEGIN
  SELECT b.organization_id, upper(b.base_currency)
    INTO _org, _base
    FROM public.businesses b WHERE b.id = _business_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this business' USING ERRCODE = '42501';
  END IF;

  FOR _row IN
    SELECT upper(je.currency) AS currency,
           SUM(COALESCE(jel.original_debit, jel.debit, 0)
             - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
           SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0))  AS booked_base,
           SUM(CASE WHEN a.detail_type = 'accounts_receivable'
                    THEN COALESCE(jel.original_debit, jel.debit, 0)
                       - COALESCE(jel.original_credit, jel.credit, 0) ELSE 0 END) AS receivable,
           SUM(CASE WHEN a.detail_type = 'accounts_payable'
                    THEN COALESCE(jel.original_debit, jel.debit, 0)
                       - COALESCE(jel.original_credit, jel.credit, 0) ELSE 0 END) AS payable,
           SUM(CASE WHEN a.detail_type IN ('checking','savings','cash_on_hand','undeposited_funds')
                    THEN COALESCE(jel.original_debit, jel.debit, 0)
                       - COALESCE(jel.original_credit, jel.credit, 0) ELSE 0 END) AS cash_bank,
           SUM(CASE WHEN COALESCE(a.detail_type,'') NOT IN
                         ('accounts_receivable','accounts_payable','checking','savings',
                          'cash_on_hand','undeposited_funds')
                    THEN COALESCE(jel.original_debit, jel.debit, 0)
                       - COALESCE(jel.original_credit, jel.credit, 0) ELSE 0 END) AS other,
           COUNT(DISTINCT jel.account_id) AS account_count
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.accounts a ON a.id = jel.account_id
     WHERE je.business_id = _business_id
       AND je.status = 'posted'
       AND je.entry_date <= _as_of
       AND je.currency IS NOT NULL
       AND upper(je.currency) <> _base
       AND a.account_type IN ('asset','liability')
     GROUP BY upper(je.currency)
    HAVING ABS(SUM(COALESCE(jel.original_debit, jel.debit, 0)
                 - COALESCE(jel.original_credit, jel.credit, 0))) > 0.01
     ORDER BY 1
  LOOP
    SELECT * INTO _r
      FROM public.describe_exchange_rate(_org, _business_id, _row.currency, _as_of);

    _rows := _rows || jsonb_build_object(
      'currency',            _row.currency,
      'foreign_balance',     _row.foreign_balance,
      'receivable',          _row.receivable,
      'payable',             _row.payable,
      'cash_bank',           _row.cash_bank,
      'other',               _row.other,
      'account_count',       _row.account_count,
      'booked_base_amount',  ROUND(_row.booked_base, 2),
      'rate',                _r.rate,
      'rate_source',         _r.source,
      'rate_provider_key',   _r.provider_key,
      'rate_effective_date', _r.effective_date,
      'rate_scope',          _r.scope,
      'revalued_base_amount',
        CASE WHEN _r.rate IS NULL OR _r.rate <= 0 THEN NULL
             ELSE ROUND(_row.foreign_balance * _r.rate, 2) END,
      'unrealized_difference',
        CASE WHEN _r.rate IS NULL OR _r.rate <= 0 THEN NULL
             ELSE ROUND(_row.foreign_balance * _r.rate - _row.booked_base, 2) END
    );

    IF _r.rate IS NULL OR _r.rate <= 0 THEN
      _missing := _missing || to_jsonb(_row.currency);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'base_currency', _base,
    'as_of',         _as_of,
    'currencies',    _rows,
    'missing_rates', _missing
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fx_exposure_open_items(_business_id uuid, _currency text, _as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _base text;
  _cur text := upper(COALESCE(_currency, ''));
  _r record;
  _items jsonb := '[]'::jsonb;
  _row record;
BEGIN
  SELECT b.organization_id, upper(b.base_currency)
    INTO _org, _base
    FROM public.businesses b WHERE b.id = _business_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this business' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r
    FROM public.describe_exchange_rate(_org, _business_id, _cur, _as_of);

  FOR _row IN
    SELECT je.id            AS journal_entry_id,
           je.entry_number,
           je.entry_date,
           je.source_type,
           je.source_id,
           je.description,
           a.id             AS account_id,
           a.code           AS account_code,
           a.name           AS account_name,
           a.detail_type,
           SUM(COALESCE(jel.original_debit, jel.debit, 0)
             - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_amount,
           SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)) AS booked_base_amount
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.accounts a ON a.id = jel.account_id
     WHERE je.business_id = _business_id
       AND je.status = 'posted'
       AND je.entry_date <= _as_of
       AND upper(COALESCE(je.currency, '')) = _cur
       AND _cur <> _base
       AND a.account_type IN ('asset','liability')
     GROUP BY je.id, je.entry_number, je.entry_date, je.source_type, je.source_id,
              je.description, a.id, a.code, a.name, a.detail_type
    HAVING ABS(SUM(COALESCE(jel.original_debit, jel.debit, 0)
                 - COALESCE(jel.original_credit, jel.credit, 0))) > 0.01
     ORDER BY je.entry_date DESC, je.entry_number DESC
     LIMIT 500
  LOOP
    _items := _items || jsonb_build_object(
      'journal_entry_id',   _row.journal_entry_id,
      'entry_number',       _row.entry_number,
      'entry_date',         _row.entry_date,
      'source_type',        _row.source_type,
      'source_id',          _row.source_id,
      'description',        _row.description,
      'account_id',         _row.account_id,
      'account_code',       _row.account_code,
      'account_name',       _row.account_name,
      'detail_type',        _row.detail_type,
      'foreign_amount',     _row.foreign_amount,
      'booked_base_amount', ROUND(_row.booked_base_amount, 2),
      'booked_rate',
        CASE WHEN _row.foreign_amount = 0 THEN NULL
             ELSE ROUND(_row.booked_base_amount / _row.foreign_amount, 6) END,
      'revalued_base_amount',
        CASE WHEN _r.rate IS NULL OR _r.rate <= 0 THEN NULL
             ELSE ROUND(_row.foreign_amount * _r.rate, 2) END,
      'difference',
        CASE WHEN _r.rate IS NULL OR _r.rate <= 0 THEN NULL
             ELSE ROUND(_row.foreign_amount * _r.rate - _row.booked_base_amount, 2) END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'base_currency',       _base,
    'currency',            _cur,
    'as_of',               _as_of,
    'rate',                _r.rate,
    'rate_source',         _r.source,
    'rate_provider_key',   _r.provider_key,
    'rate_effective_date', _r.effective_date,
    'rate_scope',          _r.scope,
    'items',               _items
  );
END;
$function$;