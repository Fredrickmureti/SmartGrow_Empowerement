
ALTER TABLE public.platform_demo_videos
  ADD COLUMN IF NOT EXISTS app_key    text,
  ADD COLUMN IF NOT EXISTS audience   text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS difficulty text;

ALTER TABLE public.platform_demo_videos
  DROP CONSTRAINT IF EXISTS platform_demo_videos_audience_check;
ALTER TABLE public.platform_demo_videos
  ADD CONSTRAINT platform_demo_videos_audience_check
  CHECK (audience IN ('public','authenticated'));

GRANT SELECT ON public.platform_demo_videos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_demo_videos TO authenticated;
GRANT ALL   ON public.platform_demo_videos TO service_role;

DROP POLICY IF EXISTS "Anyone can view published demo videos" ON public.platform_demo_videos;

CREATE POLICY "Public can view published public videos"
  ON public.platform_demo_videos FOR SELECT
  TO anon
  USING (is_published = true AND audience = 'public');

CREATE POLICY "Authenticated can view published videos"
  ON public.platform_demo_videos FOR SELECT
  TO authenticated
  USING (is_published = true OR EXISTS (
    SELECT 1 FROM public.platform_admins pa
    WHERE pa.user_id = auth.uid() AND pa.is_active = true
  ));
