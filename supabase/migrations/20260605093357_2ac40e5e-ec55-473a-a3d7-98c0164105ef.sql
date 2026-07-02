-- Wave 0: persist Access Group selections made in EmployeeInviteDialog.
-- The accept-invitation edge function already consumes invitation.permission_group_ids
-- (see supabase/functions/accept-invitation/index.ts), but the column did not
-- exist, so the field was always undefined and every invitee fell through to the
-- default group. This migration adds the column so the picker actually works.

ALTER TABLE public.organization_invitations
  ADD COLUMN IF NOT EXISTS permission_group_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.organization_invitations.permission_group_ids IS
  'Access Group IDs (permission_groups.id) to assign to the invitee on acceptance. Consumed by the accept-invitation edge function. Empty array means "use default group".';
