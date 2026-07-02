
-- Phase F: Merit recommendations

CREATE TABLE IF NOT EXISTS public.merit_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  cycle_id uuid NOT NULL REFERENCES public.performance_cycles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  review_id uuid REFERENCES public.performance_reviews(id) ON DELETE SET NULL,
  final_rating numeric,
  current_salary numeric NOT NULL DEFAULT 0,
  recommended_pct numeric NOT NULL DEFAULT 0,
  recommended_amount numeric NOT NULL DEFAULT 0,
  new_salary numeric NOT NULL DEFAULT 0,
  currency_code text,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','approved','rejected','applied')),
  notes text,
  proposed_by uuid,
  proposed_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejection_reason text,
  applied_by uuid,
  applied_at timestamptz,
  applied_history_id uuid REFERENCES public.employee_compensation_history(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.merit_recommendations TO authenticated;
GRANT ALL ON public.merit_recommendations TO service_role;

ALTER TABLE public.merit_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Talent admins manage merit recommendations"
  ON public.merit_recommendations
  FOR ALL TO authenticated
  USING (public.is_talent_admin(auth.uid(), organization_id))
  WITH CHECK (public.is_talent_admin(auth.uid(), organization_id));

CREATE POLICY "Employees view own approved/applied merit"
  ON public.merit_recommendations
  FOR SELECT TO authenticated
  USING (
    status IN ('approved','applied')
    AND employee_id = public.current_employee_id(organization_id)
  );

CREATE INDEX IF NOT EXISTS idx_merit_cycle ON public.merit_recommendations(cycle_id);
CREATE INDEX IF NOT EXISTS idx_merit_employee ON public.merit_recommendations(employee_id);
CREATE INDEX IF NOT EXISTS idx_merit_status ON public.merit_recommendations(status);

CREATE TRIGGER trg_merit_updated_at
  BEFORE UPDATE ON public.merit_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Propose (bulk upsert)
-- items: jsonb array of { employee_id, current_salary, recommended_pct, recommended_amount, new_salary, currency_code, effective_date, notes, final_rating, review_id, status? }
-- ============================================================
CREATE OR REPLACE FUNCTION public.talent_merit_propose(_cycle_id uuid, _items jsonb)
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cycle public.performance_cycles%ROWTYPE;
  _item jsonb;
  _row public.merit_recommendations;
  _status text;
BEGIN
  SELECT * INTO _cycle FROM public.performance_cycles WHERE id = _cycle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cycle not found'; END IF;

  IF NOT public.is_talent_admin(auth.uid(), _cycle.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to propose merit for this cycle';
  END IF;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    _status := COALESCE(_item->>'status', 'proposed');
    IF _status NOT IN ('draft','proposed') THEN
      RAISE EXCEPTION 'Invalid status on propose: %', _status;
    END IF;

    INSERT INTO public.merit_recommendations (
      organization_id, business_id, cycle_id, employee_id, review_id,
      final_rating, current_salary, recommended_pct, recommended_amount,
      new_salary, currency_code, effective_date, status, notes,
      proposed_by, proposed_at, created_by
    ) VALUES (
      _cycle.organization_id, _cycle.business_id, _cycle_id,
      (_item->>'employee_id')::uuid,
      NULLIF(_item->>'review_id','')::uuid,
      NULLIF(_item->>'final_rating','')::numeric,
      COALESCE((_item->>'current_salary')::numeric, 0),
      COALESCE((_item->>'recommended_pct')::numeric, 0),
      COALESCE((_item->>'recommended_amount')::numeric, 0),
      COALESCE((_item->>'new_salary')::numeric, 0),
      NULLIF(_item->>'currency_code',''),
      COALESCE(NULLIF(_item->>'effective_date','')::date, CURRENT_DATE),
      _status,
      NULLIF(_item->>'notes',''),
      CASE WHEN _status='proposed' THEN auth.uid() END,
      CASE WHEN _status='proposed' THEN now() END,
      auth.uid()
    )
    ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
      review_id = EXCLUDED.review_id,
      final_rating = EXCLUDED.final_rating,
      current_salary = EXCLUDED.current_salary,
      recommended_pct = EXCLUDED.recommended_pct,
      recommended_amount = EXCLUDED.recommended_amount,
      new_salary = EXCLUDED.new_salary,
      currency_code = EXCLUDED.currency_code,
      effective_date = EXCLUDED.effective_date,
      notes = EXCLUDED.notes,
      status = CASE
        WHEN public.merit_recommendations.status IN ('applied','approved','rejected')
          THEN public.merit_recommendations.status
        ELSE EXCLUDED.status
      END,
      proposed_by = CASE
        WHEN EXCLUDED.status='proposed' AND public.merit_recommendations.status='draft'
          THEN auth.uid() ELSE public.merit_recommendations.proposed_by
      END,
      proposed_at = CASE
        WHEN EXCLUDED.status='proposed' AND public.merit_recommendations.status='draft'
          THEN now() ELSE public.merit_recommendations.proposed_at
      END,
      updated_at = now()
    RETURNING * INTO _row;
    RETURN NEXT _row;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.talent_merit_propose(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_merit_propose(uuid, jsonb) TO authenticated;

-- ============================================================
-- Approve
-- ============================================================
CREATE OR REPLACE FUNCTION public.talent_merit_approve(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _row public.merit_recommendations;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized to approve merit %', _row.id;
    END IF;
    IF _row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Merit % is not in proposed state (got %)', _row.id, _row.status;
    END IF;
    UPDATE public.merit_recommendations
      SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;
    RETURN NEXT _row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_merit_approve(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_merit_approve(uuid[]) TO authenticated;

-- ============================================================
-- Reject
-- ============================================================
CREATE OR REPLACE FUNCTION public.talent_merit_reject(_ids uuid[], _reason text)
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _row public.merit_recommendations;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
    IF _row.status NOT IN ('proposed','approved') THEN
      RAISE EXCEPTION 'Cannot reject from status %', _row.status;
    END IF;
    UPDATE public.merit_recommendations
      SET status='rejected', rejected_by=auth.uid(), rejected_at=now(),
          rejection_reason=_reason, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;
    RETURN NEXT _row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_merit_reject(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_merit_reject(uuid[], text) TO authenticated;

-- ============================================================
-- Apply — writes employee_compensation_history rows
-- ============================================================
CREATE OR REPLACE FUNCTION public.talent_merit_apply(_ids uuid[])
RETURNS SETOF public.merit_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.merit_recommendations;
  _hist_id uuid;
BEGIN
  FOR _row IN SELECT * FROM public.merit_recommendations WHERE id = ANY(_ids) LOOP
    IF NOT public.is_talent_admin(auth.uid(), _row.organization_id) THEN
      RAISE EXCEPTION 'Not authorized to apply merit %', _row.id;
    END IF;
    IF _row.status <> 'approved' THEN
      RAISE EXCEPTION 'Merit % must be approved before apply (got %)', _row.id, _row.status;
    END IF;

    INSERT INTO public.employee_compensation_history (
      organization_id, business_id, employee_id, effective_date,
      basic_salary, allowances_json, currency_code, change_type, reason,
      approved_by, approved_at, submitted_by, submitted_at, created_by
    ) VALUES (
      _row.organization_id, _row.business_id, _row.employee_id, _row.effective_date,
      _row.new_salary, '{}'::jsonb, _row.currency_code,
      'merit_increase',
      COALESCE(_row.notes, 'Merit increase from performance cycle'),
      _row.approved_by, _row.approved_at, _row.proposed_by, _row.proposed_at, auth.uid()
    ) RETURNING id INTO _hist_id;

    UPDATE public.merit_recommendations
      SET status='applied', applied_by=auth.uid(), applied_at=now(),
          applied_history_id=_hist_id, updated_at=now()
      WHERE id = _row.id
      RETURNING * INTO _row;
    RETURN NEXT _row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.talent_merit_apply(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.talent_merit_apply(uuid[]) TO authenticated;
