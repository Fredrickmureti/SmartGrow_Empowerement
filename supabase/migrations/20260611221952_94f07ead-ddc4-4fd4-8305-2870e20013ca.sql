
-- review_templates
DROP POLICY IF EXISTS "review_templates org read"  ON public.review_templates;
DROP POLICY IF EXISTS "review_templates org write" ON public.review_templates;

CREATE POLICY "review_templates org read"
ON public.review_templates FOR SELECT
USING (
  organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
  )
);

CREATE POLICY "review_templates hr write"
ON public.review_templates FOR ALL
USING (
  public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
);

-- review_template_sections
DROP POLICY IF EXISTS "rts read"  ON public.review_template_sections;
DROP POLICY IF EXISTS "rts write" ON public.review_template_sections;

CREATE POLICY "rts read"
ON public.review_template_sections FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_sections.template_id
      AND t.organization_id IN (
        SELECT uba.organization_id FROM public.user_business_access uba
        WHERE uba.user_id = auth.uid()
      )
  )
);

CREATE POLICY "rts hr write"
ON public.review_template_sections FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_sections.template_id
      AND (
        public.has_role(auth.uid(), t.organization_id, 'admin'::public.app_role)
        OR public.has_role(auth.uid(), t.organization_id, 'owner'::public.app_role)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_sections.template_id
      AND (
        public.has_role(auth.uid(), t.organization_id, 'admin'::public.app_role)
        OR public.has_role(auth.uid(), t.organization_id, 'owner'::public.app_role)
      )
  )
);

-- review_template_questions
DROP POLICY IF EXISTS "rtq read"  ON public.review_template_questions;
DROP POLICY IF EXISTS "rtq write" ON public.review_template_questions;

CREATE POLICY "rtq read"
ON public.review_template_questions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_questions.template_id
      AND t.organization_id IN (
        SELECT uba.organization_id FROM public.user_business_access uba
        WHERE uba.user_id = auth.uid()
      )
  )
);

CREATE POLICY "rtq hr write"
ON public.review_template_questions FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_questions.template_id
      AND (
        public.has_role(auth.uid(), t.organization_id, 'admin'::public.app_role)
        OR public.has_role(auth.uid(), t.organization_id, 'owner'::public.app_role)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.review_templates t
    WHERE t.id = review_template_questions.template_id
      AND (
        public.has_role(auth.uid(), t.organization_id, 'admin'::public.app_role)
        OR public.has_role(auth.uid(), t.organization_id, 'owner'::public.app_role)
      )
  )
);

-- competency_role_requirements
DROP POLICY IF EXISTS "comp_role_req read"  ON public.competency_role_requirements;
DROP POLICY IF EXISTS "comp_role_req write" ON public.competency_role_requirements;

CREATE POLICY "comp_role_req org read"
ON public.competency_role_requirements FOR SELECT
USING (
  organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
  )
);

CREATE POLICY "comp_role_req hr write"
ON public.competency_role_requirements FOR ALL
USING (
  public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
);

-- goal_updates INSERT
DROP POLICY IF EXISTS "goal_updates insert" ON public.goal_updates;
CREATE POLICY "goal_updates insert"
ON public.goal_updates FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.performance_goals g
    WHERE g.id = goal_updates.goal_id
      AND (
        g.employee_id = public.current_employee_id(g.organization_id)
        OR public.is_manager_of(auth.uid(), g.employee_id)
        OR public.has_role(auth.uid(), g.organization_id, 'admin'::public.app_role)
        OR public.has_role(auth.uid(), g.organization_id, 'owner'::public.app_role)
      )
  )
);

-- review_participants INSERT
DROP POLICY IF EXISTS "review_participants org insert" ON public.review_participants;
CREATE POLICY "review_participants hr insert"
ON public.review_participants FOR INSERT
WITH CHECK (
  public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
);
