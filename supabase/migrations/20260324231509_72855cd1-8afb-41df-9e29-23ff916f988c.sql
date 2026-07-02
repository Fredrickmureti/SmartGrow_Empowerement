
-- P2-7: Junction table to persist cleared items during reconciliation sessions
CREATE TABLE public.bank_reconciliation_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.bank_reconciliation_sessions(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'cleared' CHECK (status IN ('cleared', 'uncleared')),
  cleared_at TIMESTAMPTZ DEFAULT now(),
  cleared_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, transaction_id)
);

ALTER TABLE public.bank_reconciliation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage reconciliation items for their org sessions"
  ON public.bank_reconciliation_items
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bank_reconciliation_sessions s
      WHERE s.id = bank_reconciliation_items.session_id
      AND s.organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.bank_reconciliation_sessions s
      WHERE s.id = bank_reconciliation_items.session_id
      AND s.organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
      )
    )
  );

CREATE INDEX idx_bank_reconciliation_items_session ON public.bank_reconciliation_items(session_id);
CREATE INDEX idx_bank_reconciliation_items_transaction ON public.bank_reconciliation_items(transaction_id);
