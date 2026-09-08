-- Wave 4 CI guard — Access Groups must actually gate data.
--
-- Two invariants:
--   1. No PERMISSIVE policy on a lending/finance table may grant access on
--      organization/business membership alone. A blanket "any member of the
--      org" policy is OR-ed with the strict access-group policies and
--      therefore cancels them out (the exact defect Wave 4a removed).
--   2. Every read/write policy on those tables must reference the
--      authorization surface: mf_can / user_has_module_permission(_in_branch)
--      / has_finance_permission / is_finance_manager / has_role.
--
-- INSERT-only subscription gates and RESTRICTIVE policies are exempt: they
-- narrow access, they never widen it.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'accounts','bank_accounts','bank_transactions','fiscal_periods',
    'journal_entries','journal_entry_lines','payments','expenses',
    'bank_reconciliation_sessions','bank_reconciliation_matches'
  ];
  v_offenders text;
BEGIN
  -- Invariant 2 (which subsumes 1 for these tables).
  SELECT string_agg(tablename || '.' || policyname || '/' || cmd, ', ' ORDER BY tablename, policyname)
    INTO v_offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND permissive = 'PERMISSIVE'
     AND cmd <> 'INSERT'
     AND (tablename = ANY (v_tables) OR tablename LIKE 'mf\_%')
     AND coalesce(qual, '') || coalesce(with_check, '')
         !~* '(mf_can|user_has_module_permission|has_finance_permission|is_finance_manager|has_role)';

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'permission-blind RLS policy on lending/finance table(s): %', v_offenders;
  END IF;

  RAISE NOTICE 'access-group RLS coverage holds';
END $$;
