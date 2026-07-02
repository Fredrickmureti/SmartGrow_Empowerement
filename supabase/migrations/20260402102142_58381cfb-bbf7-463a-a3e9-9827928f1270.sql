
-- Recurring journal templates table
CREATE TABLE public.recurring_journal_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  template_name text NOT NULL,
  description text,
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'annually')),
  next_run_date date NOT NULL,
  end_date date,
  is_auto_post boolean DEFAULT false,
  is_active boolean DEFAULT true,
  source_type text DEFAULT 'manual',
  reference_prefix text,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recurring_journal_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view recurring templates in their org"
  ON public.recurring_journal_templates FOR SELECT TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create recurring templates in their org"
  ON public.recurring_journal_templates FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update recurring templates in their org"
  ON public.recurring_journal_templates FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete recurring templates in their org"
  ON public.recurring_journal_templates FOR DELETE TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Add auto_reverse_date to journal_entries
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS auto_reverse_date date;

-- Atomic delete RPC for journal entries
CREATE OR REPLACE FUNCTION public.delete_journal_entry_atomic(_je_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
BEGIN
  SELECT status INTO _status
  FROM journal_entries
  WHERE id = _je_id AND organization_id = _org_id;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF _status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft journal entries can be deleted. Current status: %', _status;
  END IF;

  DELETE FROM journal_entry_lines WHERE journal_entry_id = _je_id;
  DELETE FROM journal_entries WHERE id = _je_id AND organization_id = _org_id;

  RETURN true;
END;
$$;
