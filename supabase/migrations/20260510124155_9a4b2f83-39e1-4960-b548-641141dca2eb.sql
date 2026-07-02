-- Keep app_install_attempts in sync with the current install_app RPC.
-- install_app records an in-flight attempt as `pending`, then updates it to
-- `success` or `blocked`. Without this value in the CHECK constraint, every
-- app install fails before any app-specific logic runs.
ALTER TABLE public.app_install_attempts
  DROP CONSTRAINT IF EXISTS app_install_attempts_outcome_check;

ALTER TABLE public.app_install_attempts
  ADD CONSTRAINT app_install_attempts_outcome_check
  CHECK (outcome IN ('pending', 'success', 'blocked', 'error'));

COMMENT ON CONSTRAINT app_install_attempts_outcome_check ON public.app_install_attempts IS
  'Allowed install attempt lifecycle states: pending while install_app is running, success after commit, blocked for entitlement/trial policy refusal, error for durable external failure logging.';