
ALTER TABLE public.training_courses
  ADD COLUMN IF NOT EXISTS recertify_months integer,
  ADD COLUMN IF NOT EXISTS is_self_enroll boolean NOT NULL DEFAULT false;

ALTER TABLE public.training_enrollments
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by uuid,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_enrollments_source_check') THEN
    ALTER TABLE public.training_enrollments
      ADD CONSTRAINT training_enrollments_source_check
      CHECK (source IN ('manual','self','auto_recert','bulk'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_training_enrollments_expires ON public.training_enrollments(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_training_courses_catalog ON public.training_courses(is_self_enroll, status) WHERE is_self_enroll = true;

-- Audit trigger
CREATE OR REPLACE FUNCTION public.audit_training_enrollments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_action text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_org := NEW.organization_id; v_action := 'training_enrollment.created';
    v_before := NULL; v_after := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_org := NEW.organization_id;
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      v_action := 'training_enrollment.status.' || NEW.status;
    ELSE
      v_action := 'training_enrollment.updated';
    END IF;
  ELSE
    v_org := OLD.organization_id; v_action := 'training_enrollment.deleted';
    v_before := to_jsonb(OLD); v_after := NULL;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, action, entity_type, entity_id, old_values, new_values, created_at)
  VALUES (v_org, auth.uid(), v_action, 'training_enrollment', COALESCE(NEW.id, OLD.id), v_before, v_after, now());

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_training_enrollments ON public.training_enrollments;
CREATE TRIGGER trg_audit_training_enrollments
  AFTER INSERT OR UPDATE OR DELETE ON public.training_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.audit_training_enrollments();

-- Auto re-enroll on completion when recertify_months is set
CREATE OR REPLACE FUNCTION public.training_auto_recert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months integer;
  v_next_due timestamptz;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT recertify_months INTO v_months FROM public.training_courses WHERE id = NEW.course_id;
    IF v_months IS NOT NULL AND v_months > 0 THEN
      v_next_due := COALESCE(NEW.completed_at, now()) + make_interval(months => v_months);

      -- Skip if a future enrollment already exists
      IF NOT EXISTS (
        SELECT 1 FROM public.training_enrollments
        WHERE employee_id = NEW.employee_id
          AND course_id = NEW.course_id
          AND id <> NEW.id
          AND status IN ('enrolled','in_progress')
      ) THEN
        INSERT INTO public.training_enrollments (
          organization_id, employee_id, course_id, status, due_date, source, assigned_by
        ) VALUES (
          NEW.organization_id, NEW.employee_id, NEW.course_id, 'enrolled', v_next_due, 'auto_recert', NEW.assigned_by
        );

        UPDATE public.training_enrollments SET expires_at = v_next_due WHERE id = NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_training_auto_recert ON public.training_enrollments;
CREATE TRIGGER trg_training_auto_recert
  AFTER UPDATE ON public.training_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.training_auto_recert();
