-- Wave B3.2 — employee_device_identifiers: many-to-one identifier table.
-- The biometric-ingest edge function consults this first, falling back to
-- employees.external_attendance_ref for one release. After cutover the
-- legacy column can be dropped.

CREATE TABLE IF NOT EXISTS public.employee_device_identifiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('badge','rfid','fingerprint','face','pin','external')),
  identifier      text NOT NULL,
  vendor          text,
  device_id       uuid REFERENCES public.attendance_devices(id) ON DELETE SET NULL,
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_device_identifiers_org_kind_id_uniq
  ON public.employee_device_identifiers(organization_id, kind, identifier)
  WHERE active = true;
CREATE INDEX IF NOT EXISTS employee_device_identifiers_employee_idx
  ON public.employee_device_identifiers(employee_id);
CREATE INDEX IF NOT EXISTS employee_device_identifiers_lookup_idx
  ON public.employee_device_identifiers(organization_id, identifier) WHERE active = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_device_identifiers TO authenticated;
GRANT ALL ON public.employee_device_identifiers TO service_role;

ALTER TABLE public.employee_device_identifiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_device_identifiers_read"
  ON public.employee_device_identifiers FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read'));

CREATE POLICY "employee_device_identifiers_write"
  ON public.employee_device_identifiers FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'write'));

CREATE POLICY "employee_device_identifiers_update"
  ON public.employee_device_identifiers FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'write'));

CREATE POLICY "employee_device_identifiers_delete"
  ON public.employee_device_identifiers FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'write'));

-- updated_at trigger using the project's existing helper.
DROP TRIGGER IF EXISTS trg_employee_device_identifiers_updated_at
  ON public.employee_device_identifiers;
CREATE TRIGGER trg_employee_device_identifiers_updated_at
  BEFORE UPDATE ON public.employee_device_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfill from employees.external_attendance_ref.
INSERT INTO public.employee_device_identifiers
  (organization_id, employee_id, kind, identifier, active, notes)
SELECT
  e.organization_id, e.id, 'external', e.external_attendance_ref, true,
  'Auto-backfilled from employees.external_attendance_ref (Wave B3.2)'
FROM public.employees e
WHERE e.external_attendance_ref IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.employee_device_identifiers edi
     WHERE edi.organization_id = e.organization_id
       AND edi.kind = 'external'
       AND edi.identifier = e.external_attendance_ref
  );

COMMENT ON TABLE public.employee_device_identifiers IS
  'Wave B3.2: many-to-one biometric/RFID/badge/PIN/face identifiers per employee. Biometric-ingest resolves identifiers here first, falling back to employees.external_attendance_ref for one release.';
