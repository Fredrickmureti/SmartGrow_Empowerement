-- =============================================================================
-- Fix: audit_logs.action CHECK constraint was too narrow.
--
-- The constraint allowed only 12 verbs:
--   {created, updated, deleted, sent, viewed, paid, partial_paid, converted,
--    approved, rejected, cancelled, voided}
--
-- but the client emits ~30+ distinct verbs across the codebase, including the
-- accounting-critical 'confirmed' (invoice/bill validation, Odoo-equivalent
-- of "Validate"), 'posted' (JE posted), 'reversed' (credit-note reversal),
-- 'reconciled' / 'unreconciled' (bank rec), and 'refunded'. Every one of
-- those was being silently rejected by Postgres with 23514, leaving holes
-- in the audit trail — unacceptable for an accounting system.
--
-- Resolution: replace the constraint with the canonical Odoo-aligned set
-- + the ops/admin verbs the app already emits. Verbs are kept lower-snake
-- to match existing convention. Future additions require a migration —
-- which is the right barrier for an audit log.
-- =============================================================================

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_action_check;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check
  CHECK (action = ANY (ARRAY[
    -- CRUD
    'created', 'updated', 'edited', 'deleted', 'restored',
    -- Document lifecycle
    'sent', 'resend', 'viewed', 'shared', 'signed', 'sign',
    -- Accounting lifecycle (Odoo-aligned)
    'confirmed', 'posted', 'reversed', 'voided', 'cancelled',
    'paid', 'partial_paid', 'refunded', 'reapplied',
    -- Approval workflow
    'approved', 'approve', 'rejected', 'submitted',
    -- Conversion / categorization
    'converted', 'categorized', 'categorize',
    -- Reconciliation
    'reconciled', 'unreconciled',
    -- POS
    'no_sale', 'manual_price', 'discount_over_limit', 'void_transaction', 'refund',
    -- Security / access
    'locked', 'unlocked', 'invite',
    -- AI / automation / system
    'ai', 'chart_ai', 'pivot_ai', 'subject_suggestions', 'translate',
    'improve', 'generate', 'html_beautify', 'query', 'simulate_callback', 'stk_push',
    -- Generic state change for forward-compat
    'cancel'
  ]));

COMMENT ON CONSTRAINT audit_logs_action_check ON public.audit_logs IS
  'Allowed audit action verbs. Aligned with Odoo accounting lifecycle (confirmed, posted, reversed, reconciled, refunded, voided) plus app-specific operational verbs. Extending requires a migration so the audit vocabulary stays governed.';