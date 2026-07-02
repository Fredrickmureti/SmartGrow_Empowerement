-- Create platform_demo_videos table for managing demo videos
CREATE TABLE public.platform_demo_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  category TEXT DEFAULT 'general',
  duration_seconds INTEGER,
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.platform_demo_videos ENABLE ROW LEVEL SECURITY;

-- Policy: Platform admins can manage all demo videos
CREATE POLICY "Platform admins can manage demo videos"
ON public.platform_demo_videos
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE platform_admins.user_id = auth.uid()
    AND platform_admins.is_active = true
  )
);

-- Policy: Public can view published demo videos
CREATE POLICY "Anyone can view published demo videos"
ON public.platform_demo_videos
FOR SELECT
USING (is_published = true);

-- Create index for sorting
CREATE INDEX idx_platform_demo_videos_sort ON public.platform_demo_videos(is_published, sort_order);

-- Create trigger for updated_at
CREATE TRIGGER update_platform_demo_videos_updated_at
BEFORE UPDATE ON public.platform_demo_videos
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();