# Statutory Returns & Remittances — Continuation Audit (2026-06-30)

Companion to `.lovable/plan.md`. Records per-slice ship status after the
independent re-audit.

## Verified shipped (re-audit, code-checked — not agent claim)

| Slice | Item | Evidence |
|---|---|---|
| A | `statutory_authorities` registry + RLS + grants | table present, populated by backfill |
| A | First-class metadata on `localization_pack_return_templates` (`authority_id`, `legal_reference`, `regulation_citation`, `effective_date`, `sunset_date`, `submission_channel`, `submission_format`, `digital_signature_spec`, `acknowledgement_spec`, `api_endpoint_spec`, `approval_required`) | column scan against `information_schema` |
| A | `return_template_v2` JSON-Schema row in `pack_rule_type_schemas` + lint wiring | seed migration |
| A | `submission_channel` CHECK dropped; engine code unchanged | `pg_constraint` scan |
| A | `govFileWriter` prefers column with body fallback | `_shared/govFileWriter.ts` |
| B | Publisher editor v2 (`ReturnTemplateEditor` + `PackEntityTabs`) surfaces authority FK, legal refs, dates, channel + structured `submission_format`, digital signature / ack / api specs, `approval_required` | component scan |
| C | Override layer extended: `submission_channel`, `submission_format`, `output`, `due_day`, `due_month_offset` on `payroll_return_template_overrides`; legal fields remain pack-owned | column scan |
| C | Discovery merge: `useReturnTemplates()` joins overrides and exposes `is_overridden` / `override_stale` | `src/hooks/payroll/useStatutoryReturns.ts` |
| C | Architecture test: legal metadata immutable on overrides | `src/test/architecture/return-override-legal-metadata-immutable.test.ts` |
| D | `payroll_return_runs` carries `approver_id`, `approved_at`, `reconciliation_status` (CHECK ∈ {unknown,ok,breach,overridden,not_applicable}), `reconciliation_breach`, `reconciliation_override_*` | column scan |
| D | State machine adds `pending_approval` between `generated` and `submitted_awaiting_ack`; submission gated on reconciliation status and approver ≠ preparer | `payroll_return_assert_transition` + `payroll_return_gate_submission` trigger |
| D | `override-return-diagnostic` edge fn (note required) | `supabase/functions/override-return-diagnostic` |
| D | `payroll_return_diagnostics` blocking-diagnostic table | migration |
| E | `payroll_remittance_payments` clearance columns (`bank_cleared_at`, `bank_cleared_transaction_id`, `bank_cleared_by`, `bank_match_confidence`) | column scan |
| E | `payroll_match_bank_remittance` AFTER trigger on `bank_transactions` auto-matches imported statements to posted remittance payments (amount + date window + reference fuzzy match) | migration |
| F | `payroll_filing_calendar` v2: override-aware `due_day`/`due_month_offset`, `pack_upgrade_proposals` join → `upgrade_pending`, latest run state + reconciliation surfaced | migration |
| G | `submit-statutory-return` metadata-driven dispatcher: reads `api_endpoint_spec`, signs per `digital_signature_spec`, persists ack to `payroll_return_filing_events`, transitions run state | function present |

## Shipped this pass

### Slice F — operator dashboard (this turn)

* New SQL fn `public.payroll_remittance_dashboard(org_id, business_id)` returns
  the five-cell payload in a single round trip:
  - `outstanding_by_authority` (authority × currency, open count, total, earliest due)
  - `returns_due_30d` (from `payroll_filing_calendar`; includes
    `is_overridden`, `override_stale`, `upgrade_pending`, `approval_required`,
    `is_overdue`)
  - `returns_pending_submission` (status ∈ {generated, pending_approval}; carries
    `reconciliation_status` so breach is visible at a glance)
  - `returns_awaiting_ack` (status = submitted_awaiting_ack)
  - `uncleared_payments` (status = posted ∧ `bank_cleared_at IS NULL`)
  `STABLE SECURITY INVOKER`, granted to `authenticated` + `service_role`; all
  rows pass through the caller's existing RLS on liabilities, return runs,
  and remittance payments.
* New `RemittanceOperatorDashboard` component (`src/components/payroll/`),
  five data-driven cells. No country branches.
* Mounted at the top of the Liabilities tab in `RemittanceTracking`.
* `ReturnsTab` status badge map extended with `pending_approval` to keep the
  Slice D state literal exhaustive at the type level.

## Cross-cutting invariants preserved

- One token resolver (`_shared/returnSourceResolver.ts`); one gov-file writer
  (`_shared/govFileWriter.ts`).
- No country-named functions; no literal rule codes in engines.
- Override coalescing remains the only path through which operational fields
  cross from pack template to runtime — legal metadata cannot be tenant-edited.
- Filing ledger immutability and SoD gates untouched.

## Build queue (remaining, optional polish)

* Wire a synthetic-authority Deno test for `submit-statutory-return` against
  the dispatcher contract (echo endpoint), so HMAC signing + ack parsing
  are covered without a real authority.
* Surface drift / upgrade-pending badges on `FilingCalendarPanel` rows (data
  is already in the v2 view; UI lift remaining).
* Optional follow-on: expose `payroll_remittance_dashboard` totals on the
  Compliance overview tile.
