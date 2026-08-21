-- Step 4 — Realized FX gain/loss report.
-- A projection over the posted ledger: realized FX is whatever hit the realized
-- gain/loss accounts on a settlement entry. The report can therefore never
-- disagree with the general ledger.

CREATE OR REPLACE FUNCTION public.fx_realized_gain_loss(
  _business_id uuid,
  _from date DEFAULT (date_trunc('year', CURRENT_DATE)::date),
  _to   date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org   uuid;
  _base  text;
  _gain  uuid;
  _loss  uuid;
  _rows  jsonb := '[]'::jsonb;
  _by_cur jsonb := '[]'::jsonb;
  _total_gain numeric := 0;
  _total_loss numeric := 0;
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
  IF _from > _to THEN
    RAISE EXCEPTION 'Start date must not be after end date' USING ERRCODE = '22007';
  END IF;

  _gain := public.resolve_fx_realized_account(_business_id, 'gain');
  _loss := public.resolve_fx_realized_account(_business_id, 'loss');

  IF _gain IS NULL AND _loss IS NULL THEN
    RETURN jsonb_build_object(
      'base_currency', _base, 'from', _from, 'to', _to,
      'accounts_configured', false,
      'settlements', '[]'::jsonb, 'by_currency', '[]'::jsonb,
      'total_gain', 0, 'total_loss', 0, 'net_realized', 0);
  END IF;

  FOR _r IN
    WITH fx AS (
      SELECT je.id                AS journal_entry_id,
             je.entry_number,
             je.entry_date,
             je.reference,
             je.description,
             je.source_type,
             je.source_id,
             upper(COALESCE(je.currency, _base)) AS currency,
             je.exchange_rate     AS settlement_rate,
             SUM(COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)) AS realized
        FROM public.journal_entry_lines jel
        JOIN public.journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.business_id = _business_id
         AND je.status = 'posted'
         AND je.entry_date BETWEEN _from AND _to
         AND jel.account_id IN (_gain, _loss)
       GROUP BY je.id, je.entry_number, je.entry_date, je.reference, je.description,
                je.source_type, je.source_id, je.currency, je.exchange_rate
      HAVING ABS(SUM(COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0))) > 0.005
    )
    SELECT fx.*,
           -- settled foreign amount and the base value the settlement was
           -- measured at, taken from the same entry's monetary lines.
           (SELECT SUM(ABS(COALESCE(l.original_debit, l.original_credit, 0)))
              FROM public.journal_entry_lines l
              JOIN public.accounts a2 ON a2.id = l.account_id
             WHERE l.journal_entry_id = fx.journal_entry_id
               AND a2.detail_type IN ('accounts_receivable','accounts_payable')
           ) AS settled_foreign_amount,
           (SELECT SUM(ABS(COALESCE(l.debit, 0) - COALESCE(l.credit, 0)))
              FROM public.journal_entry_lines l
              JOIN public.accounts a2 ON a2.id = l.account_id
             WHERE l.journal_entry_id = fx.journal_entry_id
               AND a2.detail_type IN ('accounts_receivable','accounts_payable')
           ) AS booked_base_amount,
           (SELECT c.name
              FROM public.journal_entry_lines l
              JOIN public.contacts c ON c.id = l.contact_id
             WHERE l.journal_entry_id = fx.journal_entry_id AND l.contact_id IS NOT NULL
             LIMIT 1) AS party_name
      FROM fx
     ORDER BY fx.entry_date, fx.entry_number
  LOOP
    _rows := _rows || jsonb_build_object(
      'journal_entry_id',       _r.journal_entry_id,
      'entry_number',           _r.entry_number,
      'entry_date',             _r.entry_date,
      'reference',              _r.reference,
      'description',            _r.description,
      'source_type',            _r.source_type,
      'source_id',              _r.source_id,
      'party_name',             _r.party_name,
      'currency',               _r.currency,
      'settlement_rate',        _r.settlement_rate,
      'settled_foreign_amount', _r.settled_foreign_amount,
      'booked_base_amount',     ROUND(COALESCE(_r.booked_base_amount, 0), 2),
      'booked_rate',
        CASE WHEN COALESCE(_r.settled_foreign_amount, 0) <> 0
             THEN ROUND(COALESCE(_r.booked_base_amount, 0) / _r.settled_foreign_amount, 6)
             ELSE NULL END,
      'realized_amount',        ROUND(_r.realized, 2),
      'kind',                   CASE WHEN _r.realized >= 0 THEN 'gain' ELSE 'loss' END
    );
    IF _r.realized >= 0 THEN
      _total_gain := _total_gain + _r.realized;
    ELSE
      _total_loss := _total_loss + ABS(_r.realized);
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'currency'), '[]'::jsonb) INTO _by_cur
    FROM (
      SELECT jsonb_build_object(
               'currency', s->>'currency',
               'settlement_count', COUNT(*),
               'gain',  ROUND(SUM(GREATEST((s->>'realized_amount')::numeric, 0)), 2),
               'loss',  ROUND(SUM(GREATEST(-(s->>'realized_amount')::numeric, 0)), 2),
               'net',   ROUND(SUM((s->>'realized_amount')::numeric), 2)
             ) AS x
        FROM jsonb_array_elements(_rows) s
       GROUP BY s->>'currency'
    ) g;

  RETURN jsonb_build_object(
    'base_currency',       _base,
    'from',                _from,
    'to',                  _to,
    'accounts_configured', true,
    'settlements',         _rows,
    'by_currency',         _by_cur,
    'total_gain',          ROUND(_total_gain, 2),
    'total_loss',          ROUND(_total_loss, 2),
    'net_realized',        ROUND(_total_gain - _total_loss, 2)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_realized_gain_loss(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fx_realized_gain_loss(uuid, date, date) TO authenticated, service_role;