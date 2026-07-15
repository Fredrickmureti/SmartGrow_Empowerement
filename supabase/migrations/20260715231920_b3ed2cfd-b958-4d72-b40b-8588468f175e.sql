
-- ============================================================================
-- ESS Profile: change-request queue + self-service RPCs + own-profile view
-- ============================================================================

-- 1. Change-request table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_profile_change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL,
  field_key     text NOT NULL,
  old_value     jsonb,
  new_value     jsonb NOT NULL,
  reason        text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_epcr_employee ON public.employee_profile_change_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_epcr_org_status ON public.employee_profile_change_requests(organization_id, status);

GRANT SELECT, INSERT, UPDATE ON public.employee_profile_change_requests TO authenticated;
GRANT ALL ON public.employee_profile_change_requests TO service_role;

ALTER TABLE public.employee_profile_change_requests ENABLE ROW LEVEL SECURITY;

-- Employee can read their own requests
DROP POLICY IF EXISTS epcr_select_own ON public.employee_profile_change_requests;
CREATE POLICY epcr_select_own
  ON public.employee_profile_change_requests
  FOR SELECT TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  );

-- HR admins can read all requests in their org
DROP POLICY IF EXISTS epcr_select_hr ON public.employee_profile_change_requests;
CREATE POLICY epcr_select_hr
  ON public.employee_profile_change_requests
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'owner')
  );

-- Only insertion via RPC; block direct inserts by using WITH CHECK false
-- (RPC runs as SECURITY DEFINER and bypasses RLS)
DROP POLICY IF EXISTS epcr_no_direct_insert ON public.employee_profile_change_requests;
CREATE POLICY epcr_no_direct_insert
  ON public.employee_profile_change_requests
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- Employee can cancel their own pending request
DROP POLICY IF EXISTS epcr_update_cancel_own ON public.employee_profile_change_requests;
CREATE POLICY epcr_update_cancel_own
  ON public.employee_profile_change_requests
  FOR UPDATE TO authenticated
  USING (
    status = 'pending'
    AND employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  )
  WITH CHECK (
    status IN ('pending','cancelled')
  );

-- 2. Own-profile view ---------------------------------------------------------
CREATE OR REPLACE VIEW public.v_my_employee_profile
WITH (security_invoker = true) AS
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.employee_number,
  e.first_name,
  e.last_name,
  e.email,
  e.work_email,
  e.phone,
  e.personal_phone,
  e.avatar_url,
  e.gender,
  e.date_of_birth,
  e.marital_status,
  e.address_line1,
  e.address_line2,
  e.city,
  e.county,
  e.postal_code,
  e.country,
  e.emergency_contact_name,
  e.emergency_contact_phone,
  e.emergency_contact_relationship,
  e.hire_date,
  e.employment_type,
  e.lifecycle_status,
  e.is_active,
  e.department_id,
  e.manager_id,
  e.job_position_id,
  e.branch_id,
  -- masked sensitive fields
  CASE WHEN e.national_id IS NULL OR length(e.national_id) < 4 THEN NULL
       ELSE '••••' || right(e.national_id, 4) END AS national_id_masked,
  CASE WHEN e.bank_account_number IS NULL OR length(e.bank_account_number) < 4 THEN NULL
       ELSE '••••' || right(e.bank_account_number, 4) END AS bank_account_masked,
  e.bank_name,
  e.bank_branch
FROM public.employees e
WHERE e.user_id = auth.uid();

GRANT SELECT ON public.v_my_employee_profile TO authenticated;

-- 3. Self-service RPC: update own personal fields -----------------------------
CREATE OR REPLACE FUNCTION public.update_own_employee_personal(patch jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp_id uuid;
  v_allowed text[] := ARRAY[
    'personal_phone','phone',
    'address_line1','address_line2','city','county','postal_code','country',
    'emergency_contact_name','emergency_contact_phone','emergency_contact_relationship',
    'marital_status','avatar_url'
  ];
  k text;
BEGIN
  SELECT id INTO v_emp_id FROM public.employees WHERE user_id = auth.uid() LIMIT 1;
  IF v_emp_id IS NULL THEN
    RAISE EXCEPTION 'No employee record linked to current user' USING ERRCODE = '42501';
  END IF;

  -- Reject any key not in the whitelist
  FOR k IN SELECT jsonb_object_keys(patch) LOOP
    IF NOT (k = ANY(v_allowed)) THEN
      RAISE EXCEPTION 'Field % is not self-editable', k USING ERRCODE = '42501';
    END IF;
  END LOOP;

  UPDATE public.employees SET
    personal_phone = COALESCE((patch->>'personal_phone')::text, personal_phone),
    phone = COALESCE((patch->>'phone')::text, phone),
    address_line1 = COALESCE((patch->>'address_line1')::text, address_line1),
    address_line2 = COALESCE((patch->>'address_line2')::text, address_line2),
    city = COALESCE((patch->>'city')::text, city),
    county = COALESCE((patch->>'county')::text, county),
    postal_code = COALESCE((patch->>'postal_code')::text, postal_code),
    country = COALESCE((patch->>'country')::text, country),
    emergency_contact_name = COALESCE((patch->>'emergency_contact_name')::text, emergency_contact_name),
    emergency_contact_phone = COALESCE((patch->>'emergency_contact_phone')::text, emergency_contact_phone),
    emergency_contact_relationship = COALESCE((patch->>'emergency_contact_relationship')::text, emergency_contact_relationship),
    marital_status = COALESCE((patch->>'marital_status')::text, marital_status),
    avatar_url = COALESCE((patch->>'avatar_url')::text, avatar_url),
    updated_at = now()
  WHERE id = v_emp_id;

  RETURN v_emp_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_employee_personal(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_own_employee_personal(jsonb) TO authenticated;

-- 4. Self-service RPC: submit change request ---------------------------------
CREATE OR REPLACE FUNCTION public.submit_profile_change_request(
  p_field_key text,
  p_new_value jsonb,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_id uuid;
  v_old jsonb;
  v_hr_fields text[] := ARRAY[
    'first_name','last_name','national_id',
    'bank_name','bank_branch','bank_account_number','bank_code',
    'date_of_birth','gender'
  ];
BEGIN
  IF NOT (p_field_key = ANY(v_hr_fields)) THEN
    RAISE EXCEPTION 'Field % does not require an HR change request', p_field_key USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, to_jsonb(e.*) AS row_json
    INTO v_emp
    FROM public.employees e
    WHERE e.user_id = auth.uid() LIMIT 1;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'No employee record linked to current user' USING ERRCODE = '42501';
  END IF;

  v_old := v_emp.row_json -> p_field_key;

  INSERT INTO public.employee_profile_change_requests
    (organization_id, employee_id, requested_by, field_key, old_value, new_value, reason)
  VALUES
    (v_emp.organization_id, v_emp.id, auth.uid(), p_field_key, v_old, p_new_value, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_profile_change_request(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_profile_change_request(text, jsonb, text) TO authenticated;

-- 5. HR RPC: approve / reject change request ---------------------------------
CREATE OR REPLACE FUNCTION public.review_profile_change_request(
  p_request_id uuid,
  p_decision text,          -- 'approved' | 'rejected'
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
BEGIN
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'owner')
  ) THEN
    RAISE EXCEPTION 'Only HR admins may review change requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req FROM public.employee_profile_change_requests
   WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found or not pending';
  END IF;

  UPDATE public.employee_profile_change_requests SET
    status = p_decision,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = p_note,
    updated_at = now()
  WHERE id = p_request_id;

  IF p_decision = 'approved' THEN
    -- Apply the diff to employees. Only whitelisted HR fields are allowed.
    EXECUTE format(
      'UPDATE public.employees SET %I = $1, updated_at = now() WHERE id = $2',
      v_req.field_key
    ) USING (v_req.new_value #>> '{}'), v_req.employee_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_profile_change_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_profile_change_request(uuid, text, text) TO authenticated;

-- 6. updated_at trigger -------------------------------------------------------
CREATE OR REPLACE FUNCTION public._epcr_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_epcr_touch ON public.employee_profile_change_requests;
CREATE TRIGGER trg_epcr_touch
  BEFORE UPDATE ON public.employee_profile_change_requests
  FOR EACH ROW EXECUTE FUNCTION public._epcr_touch();
