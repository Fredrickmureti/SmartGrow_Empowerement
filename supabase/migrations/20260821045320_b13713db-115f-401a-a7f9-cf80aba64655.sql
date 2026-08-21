CREATE TABLE public.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NULL,
  branch_id uuid NULL,
  app_key text NOT NULL DEFAULT 'global',
  module_key text NULL,
  record_type text NULL,
  record_id text NULL,
  scope_level text NOT NULL DEFAULT 'app',
  created_by uuid NOT NULL,
  title text NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  working_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_conversations_scope
  ON public.ai_conversations (organization_id, created_by, app_key, last_message_at DESC);
CREATE INDEX idx_ai_conversation_messages_conv
  ON public.ai_conversation_messages (conversation_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_conversations TO authenticated;
GRANT ALL ON public.ai_conversations TO service_role;
GRANT SELECT, INSERT, DELETE ON public.ai_conversation_messages TO authenticated;
GRANT ALL ON public.ai_conversation_messages TO service_role;

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_ai_conversation_scope(
  _user_id uuid,
  _organization_id uuid,
  _business_id uuid,
  _branch_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL
     AND public.user_belongs_to_org(_user_id, _organization_id)
     AND (_business_id IS NULL OR public.user_can_access_business(_user_id, _business_id))
     AND public.user_can_access_branch(_user_id, _branch_id);
$$;

CREATE OR REPLACE FUNCTION public.can_read_ai_conversation(_user_id uuid, _conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ai_conversations c
    WHERE c.id = _conversation_id
      AND c.created_by = _user_id
      AND public.can_access_ai_conversation_scope(_user_id, c.organization_id, c.business_id, c.branch_id)
  );
$$;

CREATE POLICY "Users manage their own AI conversations in accessible scopes"
ON public.ai_conversations
FOR ALL
TO authenticated
USING (
  created_by = auth.uid()
  AND public.can_access_ai_conversation_scope(auth.uid(), organization_id, business_id, branch_id)
)
WITH CHECK (
  created_by = auth.uid()
  AND public.can_access_ai_conversation_scope(auth.uid(), organization_id, business_id, branch_id)
);

CREATE POLICY "Users read messages of their accessible AI conversations"
ON public.ai_conversation_messages
FOR SELECT
TO authenticated
USING (public.can_read_ai_conversation(auth.uid(), conversation_id));

CREATE POLICY "Users insert messages into their accessible AI conversations"
ON public.ai_conversation_messages
FOR INSERT
TO authenticated
WITH CHECK (public.can_read_ai_conversation(auth.uid(), conversation_id));

CREATE POLICY "Users delete messages of their accessible AI conversations"
ON public.ai_conversation_messages
FOR DELETE
TO authenticated
USING (public.can_read_ai_conversation(auth.uid(), conversation_id));

CREATE TRIGGER trg_ai_conversations_updated_at
BEFORE UPDATE ON public.ai_conversations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();