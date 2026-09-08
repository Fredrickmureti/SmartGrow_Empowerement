
ALTER TABLE public.mf_loan_disbursements
  ADD COLUMN IF NOT EXISTS bank_transaction_id uuid REFERENCES public.bank_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mf_loan_disbursements_bank_txn
  ON public.mf_loan_disbursements (bank_transaction_id);

-- Resolve the journal entry that a disbursement already posted.
CREATE OR REPLACE FUNCTION public.mf_disbursement_journal_entry(_disbursement_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ep.journal_entry_id
    FROM public.mf_loan_disbursements d
    JOIN public.mf_loan_events ev
      ON ev.loan_id = d.loan_id
     AND ev.event_type = 'loan_disbursed'
     AND (
           (ev.payload->>'disbursement_id')::uuid = d.id
           OR (ev.payload->>'disbursed_on')::date = d.disbursed_on
         )
    JOIN public.mf_event_postings ep ON ep.loan_event_id = ev.id
   WHERE d.id = _disbursement_id
   ORDER BY ev.event_at DESC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.mf_disbursement_journal_entry(uuid) TO authenticated, service_role;

-- Candidate disbursements for an outgoing bank line.
CREATE OR REPLACE FUNCTION public.mf_bank_disbursement_candidates(_bank_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn record;
  _bank_gl uuid;
  _abs numeric;
  _out jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id;
  IF _txn.id IS NULL THEN RETURN _out; END IF;
  IF COALESCE(_txn.amount, 0) >= 0 THEN RETURN _out; END IF;  -- money leaving the bank only

  SELECT ba.account_id INTO _bank_gl FROM public.bank_accounts ba WHERE ba.id = _txn.bank_account_id;
  _abs := abs(_txn.amount);

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'score' DESC), '[]'::jsonb) INTO _out
  FROM (
    SELECT jsonb_build_object(
             'kind', 'disbursement',
             'document_type', 'disbursement',
             'document_id', d.id,
             'label', 'Loan disbursement ' || COALESCE(l.loan_number, '') ,
             'amount', COALESCE(d.net_amount, d.amount),
             'date', d.disbursed_on,
             'reference', d.reference,
             'branch_id', l.branch_id,
             'effect', 'link_only',
             'evidence', 'The loan was already disbursed and posted; this bank line is the bank confirming the payout.',
             'score', 70
               + CASE WHEN d.disbursed_on = _txn.transaction_date THEN 15 ELSE 0 END
               + CASE WHEN COALESCE(d.reference, '') <> ''
                       AND COALESCE(_txn.description, '') || ' ' || COALESCE(_txn.reference, '') ILIKE '%' || d.reference || '%'
                      THEN 15 ELSE 0 END
           ) AS x
      FROM public.mf_loan_disbursements d
      JOIN public.mf_loans l ON l.id = d.loan_id
     WHERE d.business_id = _txn.business_id
       AND d.bank_transaction_id IS NULL
       AND COALESCE(d.reversed_at, NULL) IS NULL
       AND public.mf_method_mapping_key(d.method) = 'bank'
       AND (_txn.branch_id IS NULL OR l.branch_id IS NULL OR l.branch_id = _txn.branch_id)
       AND (_bank_gl IS NULL OR public.mf_resolve_account(d.business_id, l.branch_id, 'bank') = _bank_gl)
       AND abs(COALESCE(d.net_amount, d.amount) - _abs) < 0.005
       AND d.disbursed_on BETWEEN _txn.transaction_date - 14 AND _txn.transaction_date + 7
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_reconciliation_matches m
          WHERE m.status IN ('suggested','to_check','confirmed')
            AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','disbursement','document_id', d.id))
       )
     LIMIT 10
  ) s;

  RETURN _out;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mf_bank_disbursement_candidates(uuid) TO authenticated, service_role;
