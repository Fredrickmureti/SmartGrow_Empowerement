-- The admin "manage" policy is FOR ALL to role public, so anonymous visitors
-- also evaluate its subquery against platform_admins, whose own RLS calls
-- is_platform_admin() — a function anon cannot execute. Result: every anonymous
-- read of published demo videos failed with "permission denied for function
-- is_platform_admin" even though a public-audience policy existed.
DROP POLICY IF EXISTS "Platform admins can manage demo videos" ON public.platform_demo_videos;

CREATE POLICY "Platform admins can manage demo videos"
ON public.platform_demo_videos
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins pa
    WHERE pa.user_id = auth.uid() AND pa.is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.platform_admins pa
    WHERE pa.user_id = auth.uid() AND pa.is_active = true
  )
);

GRANT SELECT ON public.platform_demo_videos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_demo_videos TO authenticated;
GRANT ALL ON public.platform_demo_videos TO service_role;