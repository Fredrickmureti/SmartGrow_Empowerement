-- Create demo_requests table for storing demo scheduling requests
CREATE TABLE public.demo_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_name TEXT,
  phone TEXT,
  message TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'completed', 'cancelled')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  contacted_at TIMESTAMPTZ,
  contacted_by UUID REFERENCES auth.users(id)
);

-- Enable RLS
ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert (public form submissions)
CREATE POLICY "Anyone can submit demo requests" 
ON public.demo_requests 
FOR INSERT 
WITH CHECK (true);

-- Only platform admins can view demo requests
CREATE POLICY "Platform admins can view demo requests" 
ON public.demo_requests 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins 
    WHERE user_id = auth.uid()
  )
);

-- Only platform admins can update demo requests
CREATE POLICY "Platform admins can update demo requests" 
ON public.demo_requests 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins 
    WHERE user_id = auth.uid()
  )
);

-- Only platform admins can delete demo requests
CREATE POLICY "Platform admins can delete demo requests" 
ON public.demo_requests 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins 
    WHERE user_id = auth.uid()
  )
);

-- Create trigger for updating updated_at timestamp
CREATE TRIGGER update_demo_requests_updated_at
BEFORE UPDATE ON public.demo_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add platform settings for demo video
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES 
  ('demo_video_url', NULL, 'string', 'URL for the demo/tutorial video (YouTube, Vimeo, or direct link)', false),
  ('demo_video_title', 'See AccrualFlow in Action', 'string', 'Title displayed on the demo video page', false),
  ('demo_video_description', 'Watch our comprehensive product demo to see how AccrualFlow can transform your business accounting.', 'text', 'Description shown on the demo video page', false)
ON CONFLICT (setting_key) DO NOTHING;