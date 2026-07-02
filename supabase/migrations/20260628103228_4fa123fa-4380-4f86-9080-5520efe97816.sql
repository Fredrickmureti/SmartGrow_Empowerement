-- Fix broken RLS predicate on employee_position_history.
-- The existing policy compared profiles.id (row PK) to auth.uid() (the user id);
-- profiles.id and auth.users.id are distinct columns, so the predicate matched
-- zero users and the table was effectively unreadable to the app.

DROP POLICY IF EXISTS eph_select_org ON public.employee_position_history;

CREATE POLICY eph_select_org
  ON public.employee_position_history
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.profiles
      WHERE user_id = auth.uid()
    )
  );