-- Fix overly permissive RLS policies for ai_usage_logs
-- Drop the permissive insert policy
DROP POLICY IF EXISTS "Service role can insert AI usage logs" ON public.ai_usage_logs;

-- The edge function will use service_role key which bypasses RLS, 
-- so we don't need an insert policy for regular users
-- Only platform admins should be able to view logs (already covered)