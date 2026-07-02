-- =====================================================================
-- Phase 4: Onboarding hardening + user reset for fredrickmureti612@gmail.com
-- =====================================================================

-- 1) Reset the stuck signup so the user can start fresh
DO $$
DECLARE
  v_user_id uuid;
  v_org_ids uuid[];
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = 'fredrickmureti612@gmail.com';

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'User fredrickmureti612@gmail.com not found — nothing to reset';
    RETURN;
  END IF;

  -- Collect orgs owned by this user (where they are the only/founding owner)
  SELECT array_agg(DISTINCT ur.organization_id)
  INTO v_org_ids
  FROM public.user_roles ur
  WHERE ur.user_id = v_user_id
    AND ur.role IN ('owner', 'super_admin');

  -- Cascade-delete the orgs (FK ON DELETE CASCADE handles children)
  IF v_org_ids IS NOT NULL THEN
    DELETE FROM public.organizations WHERE id = ANY(v_org_ids);
    RAISE NOTICE 'Deleted % owned organization(s) for %', array_length(v_org_ids, 1), v_user_id;
  END IF;

  -- Clean any stragglers tied to the user
  DELETE FROM public.user_roles WHERE user_id = v_user_id;
  DELETE FROM public.user_business_access WHERE user_id = v_user_id;
  DELETE FROM public.employees WHERE user_id = v_user_id;
  DELETE FROM public.profiles WHERE id = v_user_id;

  -- Reset onboarding metadata so the wizard runs again on next login
  UPDATE auth.users
  SET raw_user_meta_data =
        COALESCE(raw_user_meta_data, '{}'::jsonb)
        - 'onboarding_completed'
        - 'pending_company_name'
        - 'pending_business_name'
        - 'pending_country'
        - 'pending_currency'
        - 'pending_business_type'
        - 'pending_legal_name'
        - 'onboarding_idempotency_key'
  WHERE id = v_user_id;

  RAISE NOTICE 'Reset complete for %', v_user_id;
END $$;

-- =====================================================================
-- 2) Phase 4: Durable onboarding status table for resumability + telemetry
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  step text NOT NULL DEFAULT 'started',
  status text NOT NULL DEFAULT 'in_progress',
  steps_completed jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text,
  error_step text,
  attempt_count integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_status_user_key_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT onboarding_status_step_check CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status_user ON public.onboarding_status(user_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_status_status ON public.onboarding_status(status) WHERE status = 'failed';

ALTER TABLE public.onboarding_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_view_own_onboarding_status" ON public.onboarding_status;
CREATE POLICY "users_view_own_onboarding_status"
ON public.onboarding_status
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "platform_admins_view_all_onboarding_status" ON public.onboarding_status;
CREATE POLICY "platform_admins_view_all_onboarding_status"
ON public.onboarding_status
FOR SELECT
TO authenticated
USING (public.is_platform_admin(auth.uid()));

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_onboarding_status_updated_at ON public.onboarding_status;
CREATE TRIGGER trg_onboarding_status_updated_at
BEFORE UPDATE ON public.onboarding_status
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.onboarding_status IS
  'Phase-4 durable onboarding state machine. Each row records the per-user, per-idempotency-key onboarding attempt: step reached, success/failure, and provisioned org/business. Powers resumable signup and operational telemetry.';
