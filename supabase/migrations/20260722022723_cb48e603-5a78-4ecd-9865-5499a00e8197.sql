
-- =====================================================================
-- Stage 4 — Durable Reversal Saga state store.
-- Two tables (workflow + step) plus five RPCs form a resumable engine
-- that the client saga uses to run multi-leg reversals (refund + return
-- + credit-note + outbox) atomically-at-the-step level.
-- =====================================================================

-- 1) pos_reversal_workflow -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_reversal_workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id text NOT NULL,
  command_type text NOT NULL,
  command_payload jsonb NOT NULL,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  register_id uuid,
  shift_id uuid,
  cashier_id uuid,
  manager_override_id uuid REFERENCES public.pos_manager_overrides(id) ON DELETE SET NULL,
  source_transaction_id uuid,
  compensating_record_id uuid,
  status text NOT NULL DEFAULT 'pending',
  last_error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_reversal_workflow_status_chk CHECK (
    status IN ('pending','running','completed','failed','compensating','compensated')
  ),
  CONSTRAINT pos_reversal_workflow_command_type_chk CHECK (
    command_type IN (
      'void_sale','reverse_card_authorization','refund_sale',
      'return_goods','exchange','issue_store_credit'
    )
  ),
  CONSTRAINT pos_reversal_workflow_client_request_id_uk UNIQUE (client_request_id)
);

CREATE INDEX IF NOT EXISTS pos_reversal_workflow_org_status_idx
  ON public.pos_reversal_workflow (organization_id, status);
CREATE INDEX IF NOT EXISTS pos_reversal_workflow_source_txn_idx
  ON public.pos_reversal_workflow (source_transaction_id)
  WHERE source_transaction_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON public.pos_reversal_workflow TO authenticated;
GRANT ALL ON public.pos_reversal_workflow TO service_role;

ALTER TABLE public.pos_reversal_workflow ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view reversal workflows"
  ON public.pos_reversal_workflow FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "Org members can insert reversal workflows"
  ON public.pos_reversal_workflow FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "Org members can advance reversal workflows"
  ON public.pos_reversal_workflow FOR UPDATE TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- 2) pos_reversal_step -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_reversal_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.pos_reversal_workflow(id) ON DELETE CASCADE,
  step_index int NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count int NOT NULL DEFAULT 0,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_reversal_step_status_chk CHECK (
    status IN ('pending','running','completed','failed','skipped','compensated')
  ),
  CONSTRAINT pos_reversal_step_unique UNIQUE (workflow_id, step_index)
);

CREATE INDEX IF NOT EXISTS pos_reversal_step_workflow_idx
  ON public.pos_reversal_step (workflow_id, step_index);

GRANT SELECT, INSERT, UPDATE ON public.pos_reversal_step TO authenticated;
GRANT ALL ON public.pos_reversal_step TO service_role;

ALTER TABLE public.pos_reversal_step ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view reversal steps"
  ON public.pos_reversal_step FOR SELECT TO authenticated
  USING (
    workflow_id IN (
      SELECT id FROM public.pos_reversal_workflow
      WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true
      )
    )
  );

CREATE POLICY "Org members can insert reversal steps"
  ON public.pos_reversal_step FOR INSERT TO authenticated
  WITH CHECK (
    workflow_id IN (
      SELECT id FROM public.pos_reversal_workflow
      WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true
      )
    )
  );

CREATE POLICY "Org members can advance reversal steps"
  ON public.pos_reversal_step FOR UPDATE TO authenticated
  USING (
    workflow_id IN (
      SELECT id FROM public.pos_reversal_workflow
      WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true
      )
    )
  )
  WITH CHECK (
    workflow_id IN (
      SELECT id FROM public.pos_reversal_workflow
      WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid() AND is_active = true
      )
    )
  );

-- updated_at trigger reused
CREATE OR REPLACE FUNCTION public.pos_reversal_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pos_reversal_workflow_touch ON public.pos_reversal_workflow;
CREATE TRIGGER pos_reversal_workflow_touch
  BEFORE UPDATE ON public.pos_reversal_workflow
  FOR EACH ROW EXECUTE FUNCTION public.pos_reversal_touch_updated_at();

DROP TRIGGER IF EXISTS pos_reversal_step_touch ON public.pos_reversal_step;
CREATE TRIGGER pos_reversal_step_touch
  BEFORE UPDATE ON public.pos_reversal_step
  FOR EACH ROW EXECUTE FUNCTION public.pos_reversal_touch_updated_at();

-- =====================================================================
-- RPCs
-- =====================================================================

-- 3) pos_reversal_workflow_start ------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reversal_workflow_start(
  p_client_request_id text,
  p_command_type text,
  p_command_payload jsonb,
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_cashier_id uuid,
  p_manager_override_id uuid,
  p_source_transaction_id uuid,
  p_step_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_workflow public.pos_reversal_workflow;
  v_step jsonb;
  v_idx int := 0;
  v_steps jsonb;
BEGIN
  -- Idempotency: return existing workflow if client_request_id already used.
  SELECT * INTO v_workflow
  FROM public.pos_reversal_workflow
  WHERE client_request_id = p_client_request_id;

  IF FOUND THEN
    SELECT jsonb_agg(row_to_json(s.*) ORDER BY s.step_index) INTO v_steps
    FROM public.pos_reversal_step s
    WHERE s.workflow_id = v_workflow.id;
    RETURN jsonb_build_object(
      'workflow', row_to_json(v_workflow),
      'steps', COALESCE(v_steps, '[]'::jsonb),
      'resumed', true
    );
  END IF;

  INSERT INTO public.pos_reversal_workflow (
    client_request_id, command_type, command_payload,
    organization_id, business_id, branch_id, register_id, shift_id, cashier_id,
    manager_override_id, source_transaction_id, status
  ) VALUES (
    p_client_request_id, p_command_type, p_command_payload,
    p_organization_id, p_business_id, p_branch_id, p_register_id, p_shift_id, p_cashier_id,
    p_manager_override_id, p_source_transaction_id, 'running'
  )
  RETURNING * INTO v_workflow;

  FOR v_step IN SELECT * FROM jsonb_array_elements(COALESCE(p_step_plan, '[]'::jsonb))
  LOOP
    INSERT INTO public.pos_reversal_step (
      workflow_id, step_index, step_key, request_payload, status
    ) VALUES (
      v_workflow.id,
      v_idx,
      (v_step->>'key'),
      COALESCE(v_step->'request_payload', '{}'::jsonb),
      'pending'
    );
    v_idx := v_idx + 1;
  END LOOP;

  SELECT jsonb_agg(row_to_json(s.*) ORDER BY s.step_index) INTO v_steps
  FROM public.pos_reversal_step s
  WHERE s.workflow_id = v_workflow.id;

  RETURN jsonb_build_object(
    'workflow', row_to_json(v_workflow),
    'steps', COALESCE(v_steps, '[]'::jsonb),
    'resumed', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_reversal_workflow_start(
  text, text, jsonb, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb
) TO authenticated;

-- 4) pos_reversal_step_start -----------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reversal_step_start(
  p_workflow_id uuid,
  p_step_index int
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.pos_reversal_step
     SET status = 'running',
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, now())
   WHERE workflow_id = p_workflow_id
     AND step_index = p_step_index;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_reversal_step_start(uuid, int) TO authenticated;

-- 5) pos_reversal_step_record ---------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reversal_step_record(
  p_workflow_id uuid,
  p_step_index int,
  p_status text,
  p_result jsonb,
  p_error jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed','failed','skipped','compensated') THEN
    RAISE EXCEPTION 'invalid step status: %', p_status;
  END IF;

  UPDATE public.pos_reversal_step
     SET status = p_status,
         result_payload = COALESCE(p_result, result_payload),
         error = p_error,
         completed_at = CASE WHEN p_status IN ('completed','skipped','compensated')
                              THEN now() ELSE completed_at END
   WHERE workflow_id = p_workflow_id
     AND step_index = p_step_index;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_reversal_step_record(uuid, int, text, jsonb, jsonb)
  TO authenticated;

-- 6) pos_reversal_workflow_finalize ---------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reversal_workflow_finalize(
  p_workflow_id uuid,
  p_status text,
  p_compensating_record_id uuid,
  p_error jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed','failed','compensating','compensated') THEN
    RAISE EXCEPTION 'invalid workflow terminal status: %', p_status;
  END IF;

  UPDATE public.pos_reversal_workflow
     SET status = p_status,
         compensating_record_id = COALESCE(p_compensating_record_id, compensating_record_id),
         last_error = p_error,
         completed_at = CASE WHEN p_status IN ('completed','compensated')
                              THEN now() ELSE completed_at END
   WHERE id = p_workflow_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_reversal_workflow_finalize(uuid, text, uuid, jsonb)
  TO authenticated;

-- 7) pos_reversal_workflow_get --------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reversal_workflow_get(
  p_workflow_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
DECLARE
  v_workflow public.pos_reversal_workflow;
  v_steps jsonb;
BEGIN
  SELECT * INTO v_workflow
    FROM public.pos_reversal_workflow
   WHERE id = p_workflow_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_agg(row_to_json(s.*) ORDER BY s.step_index) INTO v_steps
    FROM public.pos_reversal_step s
   WHERE s.workflow_id = v_workflow.id;

  RETURN jsonb_build_object(
    'workflow', row_to_json(v_workflow),
    'steps', COALESCE(v_steps, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_reversal_workflow_get(uuid) TO authenticated;

COMMENT ON TABLE public.pos_reversal_workflow IS
'Stage 4 durable saga state — one row per reversal command; resumable via client_request_id.';
COMMENT ON TABLE public.pos_reversal_step IS
'Stage 4 durable saga step — ordered legs of a reversal; each records status, result, and error.';
