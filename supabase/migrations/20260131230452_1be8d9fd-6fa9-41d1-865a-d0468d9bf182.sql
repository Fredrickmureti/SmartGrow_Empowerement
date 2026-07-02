-- Create table to store AI-generated insights and suggestions
CREATE TABLE public.ai_insights_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  insight_type TEXT NOT NULL, -- 'financial_insights' or 'suggestions'
  content JSONB NOT NULL, -- Store the AI-generated content
  input_hash TEXT, -- Optional: hash of input data to detect when refresh is needed
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Each user can have one cached insight per type per organization
  UNIQUE(organization_id, user_id, insight_type)
);

-- Enable Row Level Security
ALTER TABLE public.ai_insights_cache ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own AI insights" 
ON public.ai_insights_cache 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own AI insights" 
ON public.ai_insights_cache 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own AI insights" 
ON public.ai_insights_cache 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own AI insights" 
ON public.ai_insights_cache 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX idx_ai_insights_cache_lookup 
ON public.ai_insights_cache(organization_id, user_id, insight_type);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_ai_insights_cache_updated_at
BEFORE UPDATE ON public.ai_insights_cache
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();