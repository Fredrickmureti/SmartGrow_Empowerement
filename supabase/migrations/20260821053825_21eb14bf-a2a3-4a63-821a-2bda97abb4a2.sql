-- Phase 4b: ai_insights_cache RLS gains a tenant predicate.
-- Previously the policies checked only auth.uid() = user_id, so a cache row
-- whose organization_id belonged to another tenant was still readable by its
-- author after they left that organization.

DROP POLICY IF EXISTS "Users can view their own AI insights" ON public.ai_insights_cache;
DROP POLICY IF EXISTS "Users can create their own AI insights" ON public.ai_insights_cache;
DROP POLICY IF EXISTS "Users can update their own AI insights" ON public.ai_insights_cache;
DROP POLICY IF EXISTS "Users can delete their own AI insights" ON public.ai_insights_cache;

CREATE POLICY "Users can view their own AI insights"
ON public.ai_insights_cache
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = ai_insights_cache.organization_id
      AND ur.is_active = true
  )
);

CREATE POLICY "Users can create their own AI insights"
ON public.ai_insights_cache
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = ai_insights_cache.organization_id
      AND ur.is_active = true
  )
);

CREATE POLICY "Users can update their own AI insights"
ON public.ai_insights_cache
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = ai_insights_cache.organization_id
      AND ur.is_active = true
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = ai_insights_cache.organization_id
      AND ur.is_active = true
  )
);

CREATE POLICY "Users can delete their own AI insights"
ON public.ai_insights_cache
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);
