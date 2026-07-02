
ALTER TABLE public.training_courses
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS objectives text,
  ADD COLUMN IF NOT EXISTS cover_image_url text,
  ADD COLUMN IF NOT EXISTS requires_certificate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pass_score numeric;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_courses_status_check') THEN
    ALTER TABLE public.training_courses
      ADD CONSTRAINT training_courses_status_check
      CHECK (status IN ('draft','published','archived'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.training_course_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file','link','text')),
  title text NOT NULL,
  description text,
  file_path text,
  file_name text,
  file_size bigint,
  mime_type text,
  external_url text,
  content_text text,
  position integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_course_materials TO authenticated;
GRANT ALL ON public.training_course_materials TO service_role;

ALTER TABLE public.training_course_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read course materials" ON public.training_course_materials;
CREATE POLICY "members read course materials"
  ON public.training_course_materials FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.organization_id = training_course_materials.organization_id
    )
  );

DROP POLICY IF EXISTS "hr manage course materials" ON public.training_course_materials;
CREATE POLICY "hr manage course materials"
  ON public.training_course_materials FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE INDEX IF NOT EXISTS idx_training_course_materials_course ON public.training_course_materials(course_id, position);
CREATE INDEX IF NOT EXISTS idx_training_course_materials_org ON public.training_course_materials(organization_id);

DROP TRIGGER IF EXISTS update_training_course_materials_updated_at ON public.training_course_materials;
CREATE TRIGGER update_training_course_materials_updated_at
  BEFORE UPDATE ON public.training_course_materials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
