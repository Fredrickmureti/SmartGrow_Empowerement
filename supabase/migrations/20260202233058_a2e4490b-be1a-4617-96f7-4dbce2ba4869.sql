-- Add column to track if sample data prompt was dismissed at org level
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS sample_data_prompt_dismissed boolean DEFAULT false;