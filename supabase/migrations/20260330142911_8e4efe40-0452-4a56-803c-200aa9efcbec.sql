-- 1. Create SECURITY DEFINER function to bypass recursive RLS
CREATE OR REPLACE FUNCTION public.user_owns_migration_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM migration_sessions ms
    JOIN user_roles ur ON ur.organization_id = ms.organization_id
    WHERE ms.id = p_session_id AND ur.user_id = auth.uid()
  );
$$;

-- Restrict to authenticated users only
REVOKE EXECUTE ON FUNCTION public.user_owns_migration_session FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_owns_migration_session TO authenticated;

-- 2. Drop the old recursive policy
DROP POLICY IF EXISTS "Users can manage migration steps via session" ON public.migration_steps;

-- 3. Create new policies using the SECURITY DEFINER function
CREATE POLICY "migration_steps_select"
ON public.migration_steps FOR SELECT TO authenticated
USING (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_steps_insert"
ON public.migration_steps FOR INSERT TO authenticated
WITH CHECK (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_steps_update"
ON public.migration_steps FOR UPDATE TO authenticated
USING (public.user_owns_migration_session(session_id))
WITH CHECK (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_steps_delete"
ON public.migration_steps FOR DELETE TO authenticated
USING (public.user_owns_migration_session(session_id));

-- 4. Also fix migration_batches if it has the same recursive pattern
DROP POLICY IF EXISTS "Users can manage migration batches via session" ON public.migration_batches;

CREATE POLICY "migration_batches_select"
ON public.migration_batches FOR SELECT TO authenticated
USING (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_batches_insert"
ON public.migration_batches FOR INSERT TO authenticated
WITH CHECK (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_batches_update"
ON public.migration_batches FOR UPDATE TO authenticated
USING (public.user_owns_migration_session(session_id))
WITH CHECK (public.user_owns_migration_session(session_id));

CREATE POLICY "migration_batches_delete"
ON public.migration_batches FOR DELETE TO authenticated
USING (public.user_owns_migration_session(session_id));