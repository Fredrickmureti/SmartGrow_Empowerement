CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(_org_id uuid, _business_id uuid, _entry_number text, _entry_date date, _description text, _reference text, _is_adjusting boolean, _is_closing boolean, _created_by uuid, _lines jsonb, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _entry_id  uuid;
  _currency  text;
BEGIN
  -- Phase 7 gate: manual JE creation requires finance.manage_je at company scope.
  PERFORM public.assert_can_manage_je(_business_id);

  -- Manual journal entries are always recorded in the company's base
  -- currency at rate 1. The posting engine requires an explicit currency
  -- (journal_entries.currency is NOT NULL); every other caller supplies it.
  SELECT b.base_currency INTO _currency
  FROM public.businesses b
  WHERE b.id = _business_id;

  IF _currency IS NULL OR btrim(_currency) = '' THEN
    RAISE EXCEPTION 'No base currency is configured for this company. Set it in company settings before creating journal entries.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Single posting monopoly: all journal writes go through
  -- post_journal_entry_atomic (balancing, period locks, scope stamping).
  --
  -- Named notation + the full 18-argument list is REQUIRED. A 16-argument
  -- call matches both the legacy 16-arg overload and the currency-aware
  -- 18-arg overload (whose last two params are defaulted), which Postgres
  -- rejects with SQLSTATE 42725 "function ... is not unique".
  _entry_id := public.post_journal_entry_atomic(
    _org_id                       => _org_id,
    _business_id                  => _business_id,
    _entry_number                 => _entry_number,
    _entry_date                   => _entry_date,
    _reference                    => _reference,
    _description                  => _description,
    _source_type                  => 'manual_journal_entry',
    _source_id                    => NULL::uuid,
    _created_by                   => _created_by,
    _is_closing                   => COALESCE(_is_closing, false),
    _is_adjusting                 => COALESCE(_is_adjusting, false),
    _lines                        => _lines,
    _currency                     => _currency,
    _exchange_rate                => 1::numeric,
    _source_subtype               => NULL::text,
    _branch_id                    => _branch_id,
    _is_opening_entry             => false,
    _amounts_in_document_currency => false
  );

  RETURN _entry_id;
END;
$function$;