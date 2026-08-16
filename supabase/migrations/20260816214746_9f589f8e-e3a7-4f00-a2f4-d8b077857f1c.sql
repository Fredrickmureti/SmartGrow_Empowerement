-- vendor_credit_notes has `credit_date`, not `credit_note_date`; the FX stamp
-- trigger referenced a non-existent field and blocked every credit raised from
-- a purchase return.
CREATE OR REPLACE FUNCTION public._tg_stamp_vcn_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_date date;
BEGIN
  v_date := COALESCE(NEW.exchange_rate_date, NEW.credit_date, CURRENT_DATE);

  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('vendor_credit_note', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted vendor credit note are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR v_date IS DISTINCT FROM COALESCE(OLD.exchange_rate_date, OLD.credit_date)
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, v_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
    NEW.exchange_rate_date := v_date;
  END IF;

  RETURN NEW;
END;
$$;

TRUNCATE public._pret_sim_log;
DO $sim$
DECLARE
  v_uid uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_pr uuid := 'a43e43af-ceac-4687-8c8b-911a7b40b221';
  v_ver int; v_res jsonb; v_log jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);
  BEGIN
    SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id=v_pr;
    v_res := public.purchase_return_raise_credit(v_pr, v_ver);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','credit','detail',v_res));
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','verify','detail', jsonb_build_object(
      'return', (SELECT jsonb_build_object('number',r.return_number,'status',r.status,'total',r.total)
                   FROM public.purchase_returns r WHERE r.id=v_pr),
      'stock_out', (SELECT jsonb_agg(jsonb_build_object('qty',m.quantity,'type',m.movement_type))
                      FROM public.stock_movements m WHERE m.reference_id=v_pr))));
  EXCEPTION WHEN OTHERS THEN
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','error','detail',
      jsonb_build_object('sqlstate',SQLSTATE,'message',SQLERRM)));
  END;
  INSERT INTO public._pret_sim_log(step, ok, detail) VALUES ('run', true, v_log);
END $sim$;