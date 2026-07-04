
-- Dead-field cleanup on Work Entry Types.
-- `color` is never rendered; `is_unpaid_leave` has no downstream consumer
-- (is_paid=false fully expresses "unpaid"). Both are pure dead metadata.

ALTER TABLE public.payroll_work_entry_types
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS is_unpaid_leave;

ALTER TABLE public.localization_pack_work_entry_type_templates
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS is_unpaid_leave;

-- Rewrite the version-bump trigger so its row-diff no longer references
-- the dropped columns.
CREATE OR REPLACE FUNCTION public.bump_payroll_wet_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    IF ROW(NEW.code, NEW.name, NEW.is_paid,
           NEW.counts_as_worked, NEW.multiplier_normal, NEW.multiplier_overtime,
           NEW.accounting_tag, NEW.sequence, NEW.is_active, NEW.business_id,
           NEW.localization_pack_id)
       IS DISTINCT FROM
       ROW(OLD.code, OLD.name, OLD.is_paid,
           OLD.counts_as_worked, OLD.multiplier_normal, OLD.multiplier_overtime,
           OLD.accounting_tag, OLD.sequence, OLD.is_active, OLD.business_id,
           OLD.localization_pack_id) THEN
      NEW.version := COALESCE(OLD.version, 1) + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Also update the pack-aware seeder so it no longer references the dropped columns.
CREATE OR REPLACE FUNCTION public.ensure_canonical_work_entry_types(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_installed_any boolean := false;
BEGIN
  WITH src AS (
    SELECT DISTINCT ON (t.code)
           t.pack_id, t.code, t.name,
           t.is_paid, t.counts_as_worked,
           t.multiplier_normal, t.multiplier_overtime,
           t.accounting_tag, t.sequence
      FROM public.installed_localization_packs ilp
      JOIN public.localization_pack_work_entry_type_templates t
        ON t.pack_id = ilp.pack_id
     WHERE ilp.organization_id = _org_id
     ORDER BY t.code, t.sequence, t.pack_id
  ),
  ins AS (
    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, localization_pack_id, code, name,
       is_paid, counts_as_worked,
       multiplier_normal, multiplier_overtime, accounting_tag, sequence,
       is_pack_default, is_active)
    SELECT _org_id, NULL, src.pack_id, src.code, src.name,
           src.is_paid, src.counts_as_worked,
           src.multiplier_normal, src.multiplier_overtime,
           src.accounting_tag, src.sequence,
           true, true
      FROM src
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM ins) INTO v_installed_any;

  -- Safety net: bare-metal orgs with no pack still get the canonical six.
  INSERT INTO public.payroll_work_entry_types
    (organization_id, business_id, code, name,
     is_paid, counts_as_worked,
     multiplier_normal, multiplier_overtime, sequence,
     is_pack_default, is_active)
  VALUES
    (_org_id, NULL, 'WORK',           'Regular work',   true,  true,  1,   1,   10,  true, true),
    (_org_id, NULL, 'OT',             'Overtime',       true,  true,  1,   1.5, 20,  true, true),
    (_org_id, NULL, 'LEAVE_PAID',     'Paid leave',     true,  true,  1,   1,   30,  true, true),
    (_org_id, NULL, 'LEAVE_UNPAID',   'Unpaid leave',   false, false, 0,   0,   40,  true, true),
    (_org_id, NULL, 'HOLIDAY',        'Public holiday', true,  true,  1,   1,   50,  true, true),
    (_org_id, NULL, 'WORKED_HOLIDAY', 'Worked holiday', true,  true,  1,   2,   60,  true, true)
  ON CONFLICT DO NOTHING;
END;
$$;
