-- WMS Labour Phase A — operator model

CREATE TABLE IF NOT EXISTS public.wms_operators (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  business_id           uuid NOT NULL,
  warehouse_id          uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  employee_id           uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  user_id               uuid,
  operator_code         text,
  home_zone_id          uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  equipment_classes     text[] NOT NULL DEFAULT '{}',
  max_concurrent_tasks  integer NOT NULL DEFAULT 1 CHECK (max_concurrent_tasks > 0),
  status                text NOT NULL DEFAULT 'off_shift'
                        CHECK (status IN ('off_shift','on_shift','break','executing')),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  is_active             boolean NOT NULL DEFAULT true,
  notes                 text,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wms_operators_wh_employee_uidx
  ON public.wms_operators (warehouse_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wms_operators_wh_user_uidx
  ON public.wms_operators (warehouse_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wms_operators_biz_wh_idx
  ON public.wms_operators (business_id, warehouse_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_operators TO authenticated;
GRANT ALL ON public.wms_operators TO service_role;
ALTER TABLE public.wms_operators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_operators_select" ON public.wms_operators
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_operators_write" ON public.wms_operators
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE TABLE IF NOT EXISTS public.wms_operator_skills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL,
  operator_id  uuid NOT NULL REFERENCES public.wms_operators(id) ON DELETE CASCADE,
  task_type    public.wms_task_type NOT NULL,
  proficiency  integer NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, task_type)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_operator_skills TO authenticated;
GRANT ALL ON public.wms_operator_skills TO service_role;
ALTER TABLE public.wms_operator_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_operator_skills_select" ON public.wms_operator_skills
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_operator_skills_write" ON public.wms_operator_skills
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE TABLE IF NOT EXISTS public.wms_operator_certifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL,
  operator_id   uuid NOT NULL REFERENCES public.wms_operators(id) ON DELETE CASCADE,
  code          text NOT NULL,
  label         text,
  issued_on     date,
  expires_on    date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, code)
);

CREATE INDEX IF NOT EXISTS wms_operator_certifications_op_idx
  ON public.wms_operator_certifications (operator_id, code);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_operator_certifications TO authenticated;
GRANT ALL ON public.wms_operator_certifications TO service_role;
ALTER TABLE public.wms_operator_certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_operator_certifications_select" ON public.wms_operator_certifications
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_operator_certifications_write" ON public.wms_operator_certifications
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE TABLE IF NOT EXISTS public.wms_task_requirements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL,
  warehouse_id       uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  task_type          public.wms_task_type NOT NULL,
  equipment_class    text,
  required_certs     text[] NOT NULL DEFAULT '{}',
  min_proficiency    integer NOT NULL DEFAULT 1 CHECK (min_proficiency BETWEEN 1 AND 5),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wms_task_requirements_uidx
  ON public.wms_task_requirements (business_id, task_type, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_task_requirements TO authenticated;
GRANT ALL ON public.wms_task_requirements TO service_role;
ALTER TABLE public.wms_task_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_task_requirements_select" ON public.wms_task_requirements
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_task_requirements_write" ON public.wms_task_requirements
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_operators_updated_at ON public.wms_operators;
CREATE TRIGGER trg_wms_operators_updated_at
  BEFORE UPDATE ON public.wms_operators
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

DROP TRIGGER IF EXISTS trg_wms_task_requirements_updated_at ON public.wms_task_requirements;
CREATE TRIGGER trg_wms_task_requirements_updated_at
  BEFORE UPDATE ON public.wms_task_requirements
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

-- Eligibility ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_operator_eligibility_enforced(_warehouse_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wms_operators
     WHERE warehouse_id = _warehouse_id AND is_active
  );
$$;

GRANT EXECUTE ON FUNCTION public.wms_operator_eligibility_enforced(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_operator_can_do_task(_user_id uuid, _task_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t   public.wms_tasks;
  op  public.wms_operators;
  req public.wms_task_requirements;
  v_skill integer;
BEGIN
  SELECT * INTO t FROM public.wms_tasks WHERE id = _task_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Gradual rollout: warehouses with no operator roster keep legacy behaviour.
  IF NOT public.wms_operator_eligibility_enforced(t.warehouse_id) THEN
    RETURN true;
  END IF;

  SELECT * INTO op FROM public.wms_operators
   WHERE warehouse_id = t.warehouse_id AND user_id = _user_id AND is_active;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO req FROM public.wms_task_requirements
   WHERE business_id = t.business_id AND task_type = t.task_type AND is_active
     AND (warehouse_id IS NULL OR warehouse_id = t.warehouse_id)
   ORDER BY (warehouse_id IS NOT NULL) DESC
   LIMIT 1;

  -- Skill: enforced only when the operator has a skill matrix at all.
  IF EXISTS (SELECT 1 FROM public.wms_operator_skills WHERE operator_id = op.id) THEN
    SELECT proficiency INTO v_skill FROM public.wms_operator_skills
     WHERE operator_id = op.id AND task_type = t.task_type;
    IF v_skill IS NULL THEN RETURN false; END IF;
    IF req.id IS NOT NULL AND v_skill < req.min_proficiency THEN RETURN false; END IF;
  END IF;

  IF req.id IS NOT NULL THEN
    IF req.equipment_class IS NOT NULL
       AND NOT (req.equipment_class = ANY(op.equipment_classes)) THEN
      RETURN false;
    END IF;

    IF array_length(req.required_certs, 1) IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM unnest(req.required_certs) AS rc(code)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.wms_operator_certifications c
           WHERE c.operator_id = op.id AND c.code = rc.code
             AND (c.expires_on IS NULL OR c.expires_on >= current_date)
        )
      ) THEN
        RETURN false;
      END IF;
    END IF;
  END IF;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_operator_can_do_task(uuid, uuid) TO authenticated;

-- Operator board view -------------------------------------------------------

CREATE OR REPLACE VIEW public.wms_operator_board_view
WITH (security_invoker = true) AS
SELECT
  o.id                          AS operator_id,
  o.business_id,
  o.warehouse_id,
  o.user_id,
  o.employee_id,
  o.operator_code,
  o.status,
  o.status_changed_at,
  o.is_active,
  o.home_zone_id,
  o.equipment_classes,
  o.max_concurrent_tasks,
  TRIM(BOTH ' ' FROM COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS operator_name,
  e.employee_number,
  (SELECT COUNT(*) FROM public.wms_tasks t
     WHERE t.assignee_user_id = o.user_id
       AND t.warehouse_id = o.warehouse_id
       AND t.state::text IN ('assigned','claimed','in_progress','paused','resumed')) AS open_tasks,
  (SELECT COALESCE(SUM(t.earned_seconds),0) FROM public.wms_tasks t
     WHERE t.assignee_user_id = o.user_id
       AND t.warehouse_id = o.warehouse_id
       AND t.state::text = 'done'
       AND t.completed_at >= date_trunc('day', now())) AS earned_seconds_today,
  (SELECT COALESCE(SUM(t.actual_seconds),0) FROM public.wms_tasks t
     WHERE t.assignee_user_id = o.user_id
       AND t.warehouse_id = o.warehouse_id
       AND t.state::text = 'done'
       AND t.completed_at >= date_trunc('day', now())) AS actual_seconds_today
FROM public.wms_operators o
LEFT JOIN public.employees e ON e.id = o.employee_id;

GRANT SELECT ON public.wms_operator_board_view TO authenticated, service_role;