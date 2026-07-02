
CREATE TABLE IF NOT EXISTS public.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  name text NOT NULL,
  code text,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0,
  paid_break boolean NOT NULL DEFAULT false,
  crosses_midnight boolean NOT NULL DEFAULT false,
  night_differential_pct numeric(6,3) NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#3b82f6',
  is_active boolean NOT NULL DEFAULT true,
  description text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shifts TO authenticated;
GRANT ALL ON public.shifts TO service_role;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY shifts_org_read ON public.shifts FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY shifts_admin_write ON public.shifts FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));
CREATE TRIGGER trg_shifts_updated_at BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE RESTRICT,
  assignment_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','published','swapped','cancelled','completed','no_show')),
  source text NOT NULL DEFAULT 'planned'
    CHECK (source IN ('planned','swap','on_call','overtime','adjusted')),
  notes text,
  published_at timestamptz,
  published_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, assignment_date, shift_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_assignments TO authenticated;
GRANT ALL ON public.shift_assignments TO service_role;
ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sa_self_or_hr_read ON public.shift_assignments FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id) AND (
      EXISTS (SELECT 1 FROM public.employees e
               WHERE e.id = shift_assignments.employee_id AND e.user_id = auth.uid())
      OR public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
    )
  );
CREATE POLICY sa_hr_write ON public.shift_assignments FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));
CREATE INDEX IF NOT EXISTS shift_assignments_emp_date_idx ON public.shift_assignments (employee_id, assignment_date);
CREATE INDEX IF NOT EXISTS shift_assignments_org_date_idx ON public.shift_assignments (organization_id, assignment_date);
CREATE TRIGGER trg_shift_assignments_updated_at BEFORE UPDATE ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.roster_overlap_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_start timestamptz;
  new_end timestamptz;
  conflict_id uuid;
BEGIN
  IF NEW.status IN ('cancelled','no_show') THEN RETURN NEW; END IF;
  SELECT (NEW.assignment_date + s.start_time)::timestamptz,
         (CASE WHEN s.crosses_midnight OR s.end_time <= s.start_time
               THEN (NEW.assignment_date + interval '1 day' + s.end_time)::timestamptz
               ELSE (NEW.assignment_date + s.end_time)::timestamptz END)
    INTO new_start, new_end
    FROM public.shifts s WHERE s.id = NEW.shift_id;

  SELECT a.id INTO conflict_id
    FROM public.shift_assignments a
    JOIN public.shifts s ON s.id = a.shift_id
   WHERE a.employee_id = NEW.employee_id
     AND a.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND a.status NOT IN ('cancelled','no_show')
     AND a.assignment_date BETWEEN (NEW.assignment_date - 1) AND (NEW.assignment_date + 1)
     AND tstzrange(
           (a.assignment_date + s.start_time)::timestamptz,
           (CASE WHEN s.crosses_midnight OR s.end_time <= s.start_time
                 THEN (a.assignment_date + interval '1 day' + s.end_time)::timestamptz
                 ELSE (a.assignment_date + s.end_time)::timestamptz END),
           '[)'
         ) && tstzrange(new_start, new_end, '[)')
   LIMIT 1;

  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'Roster assignment overlaps an existing assignment for this employee.'
      USING ERRCODE = '23P01', HINT = 'roster_assignment_overlap';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_roster_overlap_guard
  BEFORE INSERT OR UPDATE OF employee_id, shift_id, assignment_date, status
  ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.roster_overlap_guard();

CREATE TABLE IF NOT EXISTS public.shift_swap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  requester_employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  requester_assignment_id uuid NOT NULL REFERENCES public.shift_assignments(id) ON DELETE CASCADE,
  target_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  target_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','target_accepted','target_declined','approved','rejected','cancelled','applied')),
  target_responded_at timestamptz,
  target_response_by uuid,
  approver_decided_at timestamptz,
  approver_user_id uuid,
  approver_notes text,
  applied_at timestamptz,
  applied_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_swap_requests TO authenticated;
GRANT ALL ON public.shift_swap_requests TO service_role;
ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY ssr_party_or_hr_read ON public.shift_swap_requests FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id) AND (
      EXISTS (SELECT 1 FROM public.employees e
               WHERE e.user_id = auth.uid()
                 AND e.id IN (requester_employee_id, target_employee_id))
      OR public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
    )
  );
CREATE POLICY ssr_requester_insert ON public.shift_swap_requests FOR INSERT TO authenticated
  WITH CHECK (
    public.is_org_member(auth.uid(), organization_id) AND
    EXISTS (SELECT 1 FROM public.employees e
             WHERE e.id = requester_employee_id AND e.user_id = auth.uid())
  );
CREATE POLICY ssr_party_or_hr_update ON public.shift_swap_requests FOR UPDATE TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id) AND (
      EXISTS (SELECT 1 FROM public.employees e
               WHERE e.user_id = auth.uid()
                 AND e.id IN (requester_employee_id, target_employee_id))
      OR public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write')
    )
  )
  WITH CHECK (true);
CREATE POLICY ssr_hr_delete ON public.shift_swap_requests FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE TRIGGER trg_ssr_updated_at BEFORE UPDATE ON public.shift_swap_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.roster_swap_approver_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  req_user uuid;
  tgt_user uuid;
BEGIN
  IF NEW.status IN ('approved','rejected') AND NEW.approver_user_id IS NOT NULL THEN
    SELECT user_id INTO req_user FROM public.employees WHERE id = NEW.requester_employee_id;
    SELECT user_id INTO tgt_user FROM public.employees WHERE id = NEW.target_employee_id;
    IF NEW.approver_user_id = req_user OR NEW.approver_user_id = tgt_user THEN
      RAISE EXCEPTION 'Swap approver cannot be the requester or the target employee.'
        USING ERRCODE = '42501', HINT = 'roster_swap_approver_conflict';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_roster_swap_approver_guard
  BEFORE INSERT OR UPDATE OF status, approver_user_id ON public.shift_swap_requests
  FOR EACH ROW EXECUTE FUNCTION public.roster_swap_approver_guard();
