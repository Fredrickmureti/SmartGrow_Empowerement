DO $$ BEGIN
  CREATE TYPE public.ar_promise_status AS ENUM ('open','kept','broken','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.ar_promises_to_pay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  document_id uuid,
  promised_amount numeric NOT NULL CHECK (promised_amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  base_promised_amount numeric NOT NULL DEFAULT 0,
  expected_payment_date date NOT NULL,
  status public.ar_promise_status NOT NULL DEFAULT 'open',
  notes text,
  /* Residual (base currency) at the moment the promise was made — the
     benchmark used to decide whether the promise was kept. */
  baseline_residual numeric NOT NULL DEFAULT 0,
  client_request_id text,
  created_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_promises_to_pay_request_key
  ON public.ar_promises_to_pay (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ar_promises_to_pay_scope_idx
  ON public.ar_promises_to_pay (organization_id, business_id, contact_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_promises_to_pay TO authenticated;
GRANT ALL ON public.ar_promises_to_pay TO service_role;

ALTER TABLE public.ar_promises_to_pay ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view promises to pay" ON public.ar_promises_to_pay;
CREATE POLICY "Org members can view promises to pay"
  ON public.ar_promises_to_pay FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Org members can manage promises to pay" ON public.ar_promises_to_pay;
CREATE POLICY "Org members can manage promises to pay"
  ON public.ar_promises_to_pay FOR ALL TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS update_ar_promises_to_pay_updated_at ON public.ar_promises_to_pay;
CREATE TRIGGER update_ar_promises_to_pay_updated_at
  BEFORE UPDATE ON public.ar_promises_to_pay
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.record_promise_to_pay(
  _business_id uuid,
  _contact_id uuid,
  _promised_amount numeric,
  _expected_payment_date date,
  _currency text DEFAULT NULL,
  _document_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _notes text DEFAULT NULL,
  _client_request_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_currency text;
  v_base numeric;
  v_baseline numeric;
  v_existing uuid;
  v_id uuid;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;
  IF _promised_amount IS NULL OR _promised_amount <= 0 THEN
    RAISE EXCEPTION 'Promised amount must be positive';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.ar_promises_to_pay
    WHERE organization_id = v_org AND client_request_id = _client_request_id;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_currency := COALESCE(_currency, (SELECT base_currency FROM public.businesses WHERE id = _business_id), 'KES');
  v_base := public.to_base_amount(_promised_amount, v_currency, _business_id, CURRENT_DATE);

  SELECT COALESCE(SUM(np.net_amount), 0) INTO v_baseline
  FROM public.finance_ar_net_position np
  WHERE np.organization_id = v_org
    AND np.business_id = _business_id
    AND np.contact_id = _contact_id;

  INSERT INTO public.ar_promises_to_pay (
    organization_id, business_id, branch_id, contact_id, document_id,
    promised_amount, currency, base_promised_amount, expected_payment_date,
    notes, baseline_residual, client_request_id, created_by
  ) VALUES (
    v_org, _business_id, _branch_id, _contact_id, _document_id,
    _promised_amount, v_currency, v_base, _expected_payment_date,
    _notes, v_baseline, _client_request_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_promise_to_pay(uuid, uuid, numeric, date, text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_promise_to_pay(uuid, uuid, numeric, date, text, uuid, uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.evaluate_promise_status(_business_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed integer := 0;
BEGIN
  WITH pos AS (
    SELECT organization_id, business_id, contact_id, SUM(net_amount) AS net_amount
    FROM public.finance_ar_net_position
    GROUP BY organization_id, business_id, contact_id
  ),
  evaluated AS (
    SELECT p.id,
           CASE
             WHEN COALESCE(pos.net_amount, 0) <= p.baseline_residual - p.base_promised_amount + 0.01
               THEN 'kept'::public.ar_promise_status
             WHEN p.expected_payment_date < CURRENT_DATE
               THEN 'broken'::public.ar_promise_status
             ELSE NULL
           END AS new_status
    FROM public.ar_promises_to_pay p
    LEFT JOIN pos
      ON pos.organization_id = p.organization_id
     AND pos.business_id = p.business_id
     AND pos.contact_id = p.contact_id
    WHERE p.status = 'open'
      AND (_business_id IS NULL OR p.business_id = _business_id)
  )
  UPDATE public.ar_promises_to_pay t
  SET status = e.new_status, resolved_at = now()
  FROM evaluated e
  WHERE t.id = e.id AND e.new_status IS NOT NULL;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_promise_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_promise_status(uuid) TO authenticated, service_role;