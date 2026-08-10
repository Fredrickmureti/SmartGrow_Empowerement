DO $$ BEGIN
  CREATE TYPE public.ar_dispute_status AS ENUM ('open','resolved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.ar_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  document_id uuid,
  dispute_type text NOT NULL DEFAULT 'other',
  reason text,
  amount_disputed numeric NOT NULL DEFAULT 0 CHECK (amount_disputed >= 0),
  currency text NOT NULL DEFAULT 'KES',
  base_amount_disputed numeric NOT NULL DEFAULT 0,
  status public.ar_dispute_status NOT NULL DEFAULT 'open',
  resolution_note text,
  client_request_id text,
  raised_by uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_disputes_request_key
  ON public.ar_disputes (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ar_disputes_scope_idx
  ON public.ar_disputes (organization_id, business_id, contact_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_disputes TO authenticated;
GRANT ALL ON public.ar_disputes TO service_role;

ALTER TABLE public.ar_disputes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view ar disputes" ON public.ar_disputes;
CREATE POLICY "Org members can view ar disputes"
  ON public.ar_disputes FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Org members can manage ar disputes" ON public.ar_disputes;
CREATE POLICY "Org members can manage ar disputes"
  ON public.ar_disputes FOR ALL TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS update_ar_disputes_updated_at ON public.ar_disputes;
CREATE TRIGGER update_ar_disputes_updated_at
  BEFORE UPDATE ON public.ar_disputes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.raise_ar_dispute(
  _business_id uuid,
  _contact_id uuid,
  _amount_disputed numeric,
  _dispute_type text DEFAULT 'other',
  _reason text DEFAULT NULL,
  _currency text DEFAULT NULL,
  _document_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
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
  IF _amount_disputed IS NULL OR _amount_disputed < 0 THEN
    RAISE EXCEPTION 'Disputed amount cannot be negative';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.ar_disputes
    WHERE organization_id = v_org AND client_request_id = _client_request_id;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_currency := COALESCE(_currency, (SELECT base_currency FROM public.businesses WHERE id = _business_id), 'KES');
  v_base := public.to_base_amount(_business_id, v_currency, _amount_disputed, CURRENT_DATE);

  INSERT INTO public.ar_disputes (
    organization_id, business_id, branch_id, contact_id, document_id,
    dispute_type, reason, amount_disputed, currency, base_amount_disputed,
    client_request_id, raised_by
  ) VALUES (
    v_org, _business_id, _branch_id, _contact_id, _document_id,
    COALESCE(_dispute_type, 'other'), _reason, _amount_disputed, v_currency, v_base,
    _client_request_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.raise_ar_dispute(uuid, uuid, numeric, text, text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.raise_ar_dispute(uuid, uuid, numeric, text, text, text, uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_ar_dispute(
  _dispute_id uuid,
  _status public.ar_dispute_status,
  _resolution_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.ar_disputes WHERE id = _dispute_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;
  IF _status = 'open' THEN
    RAISE EXCEPTION 'Use open only at creation time';
  END IF;

  UPDATE public.ar_disputes
  SET status = _status,
      resolution_note = COALESCE(_resolution_note, resolution_note),
      resolved_by = auth.uid(),
      resolved_at = now()
  WHERE id = _dispute_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_ar_dispute(uuid, public.ar_dispute_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_ar_dispute(uuid, public.ar_dispute_status, text) TO authenticated, service_role;