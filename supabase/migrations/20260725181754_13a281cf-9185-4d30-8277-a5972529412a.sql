-- ============================================================
-- Phase 2 — Approval & Governance Consolidation
-- Schema hardening: versioning, snapshots, idempotency, hash-chained audit,
-- hard FK from approval_rules.action_name → governance_action_registry.
-- All target tables are currently empty (verified pre-migration), so
-- cutover is safe without a data-backfill step.
-- ============================================================

-- ---------- 1. Ensure registry.action_key is uniquely referenceable ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_action_registry_action_key_uk'
  ) THEN
    ALTER TABLE public.governance_action_registry
      ADD CONSTRAINT governance_action_registry_action_key_uk UNIQUE (action_key);
  END IF;
END$$;

-- ---------- 2. approval_workflows — versioning ----------
ALTER TABLE public.approval_workflows
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.approval_workflows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS definition_hash text;

CREATE INDEX IF NOT EXISTS idx_approval_workflows_published
  ON public.approval_workflows(organization_id, is_published) WHERE is_published;

-- ---------- 3. approval_workflow_steps — optional registry link ----------
ALTER TABLE public.approval_workflow_steps
  ADD COLUMN IF NOT EXISTS action_key text
    REFERENCES public.governance_action_registry(action_key) ON UPDATE CASCADE;

-- ---------- 4. approval_requests — snapshots + idempotency ----------
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS action_key text
    REFERENCES public.governance_action_registry(action_key) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS workflow_version integer,
  ADD COLUMN IF NOT EXISTS policy_version integer,
  ADD COLUMN IF NOT EXISTS payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS dedupe_hash text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_requests_org_idem
  ON public.approval_requests(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approval_requests_entity
  ON public.approval_requests(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_action
  ON public.approval_requests(organization_id, action_key, status);

-- Touch trigger for updated_at
CREATE OR REPLACE FUNCTION public._approval_requests_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_approval_requests_touch ON public.approval_requests;
CREATE TRIGGER trg_approval_requests_touch
  BEFORE UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._approval_requests_touch();

-- ---------- 5. approval_history — hash-chained tamper-evident log ----------
ALTER TABLE public.approval_history
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'decision',
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS event_seq bigint,
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS event_hash text,
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_approval_history_request
  ON public.approval_history(request_id, event_seq);

-- Per-request monotonic sequence + SHA-256 hash chain.
-- event_hash = sha256( request_id || event_seq || event_type || action ||
--                      coalesce(actor,'') || coalesce(prev_hash,'') ||
--                      payload::text || recorded_at )
CREATE OR REPLACE FUNCTION public._approval_history_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prev_seq  bigint;
  v_prev_hash text;
  v_material  text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Chain rows are append-only; block any UPDATE/DELETE that would
    -- mutate the hash-carrying columns.
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'approval_history is append-only'
        USING ERRCODE = '42501', HINT = 'GOV_APPEND_ONLY';
    END IF;
    IF NEW.event_seq   IS DISTINCT FROM OLD.event_seq
       OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
       OR NEW.event_hash IS DISTINCT FROM OLD.event_hash
       OR NEW.payload    IS DISTINCT FROM OLD.payload
       OR NEW.action     IS DISTINCT FROM OLD.action
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.recorded_at   IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'approval_history rows are immutable'
        USING ERRCODE = '42501', HINT = 'GOV_APPEND_ONLY';
    END IF;
    RETURN NEW;
  END IF;

  SELECT event_seq, event_hash
    INTO v_prev_seq, v_prev_hash
    FROM public.approval_history
   WHERE request_id = NEW.request_id
   ORDER BY event_seq DESC
   LIMIT 1;

  NEW.event_seq := COALESCE(v_prev_seq, 0) + 1;
  NEW.prev_hash := v_prev_hash;
  IF NEW.recorded_at IS NULL THEN
    NEW.recorded_at := now();
  END IF;

  v_material := NEW.request_id::text
             || '|' || NEW.event_seq::text
             || '|' || COALESCE(NEW.event_type,'')
             || '|' || COALESCE(NEW.action,'')
             || '|' || COALESCE(NEW.actor_user_id::text,'')
             || '|' || COALESCE(NEW.prev_hash,'')
             || '|' || COALESCE(NEW.payload::text,'{}')
             || '|' || NEW.recorded_at::text;

  NEW.event_hash := encode(digest(v_material, 'sha256'), 'hex');
  RETURN NEW;
END$$;

-- pgcrypto for digest()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TRIGGER IF EXISTS trg_approval_history_chain_ins ON public.approval_history;
CREATE TRIGGER trg_approval_history_chain_ins
  BEFORE INSERT ON public.approval_history
  FOR EACH ROW EXECUTE FUNCTION public._approval_history_chain();

DROP TRIGGER IF EXISTS trg_approval_history_chain_upd ON public.approval_history;
CREATE TRIGGER trg_approval_history_chain_upd
  BEFORE UPDATE OR DELETE ON public.approval_history
  FOR EACH ROW EXECUTE FUNCTION public._approval_history_chain();

-- ---------- 6. approval_rules — hard FK cutover ----------
-- Drop the soft trigger from Phase 1 (name defined in Phase 1 migration).
DROP TRIGGER IF EXISTS trg_approval_rules_registry_check ON public.approval_rules;

-- Enforce action_name membership via FK. Verified empty pre-migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'approval_rules_action_name_fk'
  ) THEN
    ALTER TABLE public.approval_rules
      ADD CONSTRAINT approval_rules_action_name_fk
      FOREIGN KEY (action_name)
      REFERENCES public.governance_action_registry(action_key)
      ON UPDATE CASCADE;
  END IF;
END$$;

-- ---------- 7. Chain verifier RPC (read-only integrity check) ----------
CREATE OR REPLACE FUNCTION public.approval_history_verify(_request_id uuid)
RETURNS TABLE(event_seq bigint, ok boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r         record;
  v_prev    text := NULL;
  v_material text;
  v_expected text;
BEGIN
  FOR r IN
    SELECT * FROM public.approval_history
     WHERE request_id = _request_id
     ORDER BY event_seq ASC
  LOOP
    v_material := r.request_id::text
               || '|' || r.event_seq::text
               || '|' || COALESCE(r.event_type,'')
               || '|' || COALESCE(r.action,'')
               || '|' || COALESCE(r.actor_user_id::text,'')
               || '|' || COALESCE(v_prev,'')
               || '|' || COALESCE(r.payload::text,'{}')
               || '|' || r.recorded_at::text;
    v_expected := encode(digest(v_material, 'sha256'), 'hex');

    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      event_seq := r.event_seq; ok := false; reason := 'prev_hash mismatch';
      RETURN NEXT;
    ELSIF r.event_hash <> v_expected THEN
      event_seq := r.event_seq; ok := false; reason := 'event_hash mismatch';
      RETURN NEXT;
    ELSE
      event_seq := r.event_seq; ok := true; reason := NULL;
      RETURN NEXT;
    END IF;
    v_prev := r.event_hash;
  END LOOP;
  RETURN;
END$$;

REVOKE ALL ON FUNCTION public.approval_history_verify(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_history_verify(uuid) TO authenticated, service_role;