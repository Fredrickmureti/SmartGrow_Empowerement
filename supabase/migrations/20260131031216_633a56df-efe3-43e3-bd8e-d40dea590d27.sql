-- Fix the overly permissive INSERT policy on user_activity_logs
DROP POLICY IF EXISTS "Service role can insert activity logs" ON public.user_activity_logs;

CREATE POLICY "Users can log their own activity"
ON public.user_activity_logs FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Also allow service role to insert (for edge functions)
CREATE POLICY "Service role can insert any activity logs"
ON public.user_activity_logs FOR INSERT
TO service_role
WITH CHECK (true);