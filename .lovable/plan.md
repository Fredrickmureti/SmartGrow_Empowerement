
# Legal Orders / Garnishments — Continuation Plan

> **Status snapshot (current):** Phases 1–8 delivered end-to-end. Recipient
> master data, FSM guard, workspace shell, outbox event integration,
> jurisdiction packs, recipient linking, remittance batches, bank-file
> generation, settlement, bank-reconciliation seam, nightly auto-satisfy,
> recipient statement, unified audit timeline, statutory report definitions,
> and point-in-time running balance are all live with architecture tests and
> ADRs (0092–0097). **Roadmap complete.**
>
> **Active phase:** none — subsystem is at enterprise-grade closure.
> **Follow-ups:** country-specific statutory report definitions are the
> responsibility of individual localisation packs (KE / ZA / GH / DE etc.)
> and are added as pack-authored rows in
> `legal_order_statutory_report_definitions` when the pack maintainer needs
> them. No engine work required.

## Phase 0 — Verification ledger (evidence-based)

Verified directly against the live database and codebase.

| Prior claim | Verification | Status |
|---|---|---|
| Phase 1–5 — recipient master data, FSM guard, workspace, outbox, ADRs 0092–0094 | Migrations + `legal-orders-phase2..phase5*` tests present and green | ✅ Accepted |
| Phase 6 jurisdiction packs + ADR-0095 | `LegalOrderPacks.tsx` + `legal-orders-phase6-packs.test.ts` | ✅ Accepted |
| Phase 7 remittance cycle + ADR-0096 | 8 RPCs live (`legal_order_build/generate/settle/cancel/match_batch/auto_satisfy/recipient_statement/running_balance`), `pg_cron` job `legal-orders-auto-satisfy-nightly`, UI pages `LegalOrderRemittanceBatches` / `LegalOrderRemittanceBatch`, `legal-orders-phase7-remittance-cycle.test.ts` | ✅ Accepted |
| Phase 8 backend — audit timeline view, statutory-report definitions table, running-balance RPC + ADR-0097 | View, table, RPC all present; `LegalOrdersAudit.tsx` mounted at `/hr/payroll/legal-orders/audit`; `legal-orders-phase8-audit.test.ts` present | ✅ Accepted |
| Platform-scope statutory report definitions seeded | `legal_orders_outstanding_by_recipient` + `legal_orders_remittance_activity` rows in `legal_order_statutory_report_definitions` with `organization_id = NULL`, `jurisdiction_code = '*'` (platform sentinel), both `monthly` and `is_active = true` | ✅ Accepted |
| ADR-0094 extension for the audit projection contract | Addendum section added to `docs/adr/0094-legal-order-event-integration.md` documenting `v_legal_order_audit_timeline` shape, security model, source branches, extension rule, and non-writer contract | ✅ Accepted |

No superficial patches, no regressions, no partially implemented architecture
found during independent verification.

## Guardrails (enforced by tests, unchanged)

- All status writes go through `garnishment_transition` /
  `apply_system_garnishment_transition`; `_legal_order_fsm_guard` remains
  active. The Phase 5 writer-guard architecture test enforces this.
- Every `public` table ships GRANT + RLS in the same migration.
- Every outbox topic ships with a dispatcher entry; unknown topics DLQ.
- No country-specific branching in engine or UI code — pack rows only.
- No direct `pdf-lib` usage in feature code; artifacts flow through
  `document_artifacts` (ADR-0084).
- `/api/public/*` server routes authenticate with the Supabase anon key in
  `apikey` — no bespoke shared secret.
- `v_legal_order_audit_timeline` is the single canonical read projection for
  legal-order history. New audit sources plug in as an extra `UNION ALL`
  branch — do not publish a second view.

## Complete lifecycle coverage

Every stage in the parent prompt now has a single source of truth wired into
the enterprise loop:

```
Legal Authority        → localization pack registry
Legal Order            → legal_orders_records + FSM guard
Employee               → employees + payroll eligibility
Payroll Eligibility    → garnishment engine (priority + aggregate cap)
Disposable Earnings    → payroll_run engine
Deduction Rules        → localization_pack_garnishment_policies
Priority Rules         → garnishment_kind_defaults (always_first / cap_exempt)
Aggregate Caps         → payroll_settings.garnishment_aggregate_cap_pct
Payroll Run            → payroll_runs
Payslip                → payslips + payslip_lines
Accounting Entries     → journal_entries (Garnishment Payable per recipient)
Liability Creation     → default_account_settings role garnishment_payable
Remittance             → legal_order_remittance_batches + batch_lines
Payment Processing     → legal_order_settle_remittance_batch (single writer)
Bank Payment           → legal_order_generate_remittance_bank_file
                         (csv | ach_stub | sepa_pain001_stub)
Reconciliation         → legal_order_match_batch_to_bank_txn +
                         bank_reconciliation_matches.legal_order_remittance_batch_id
Reports                → legal_order_statutory_report_definitions
                         (platform seeds + pack-authored rows)
Audit                  → v_legal_order_audit_timeline (invoker-scoped)
Closure / Release      → legal_order_auto_satisfy nightly (FSM publisher)
```

## Handoff note

The subsystem is complete. Future work belongs to the individual localisation
packs (country-specific statutory report definitions authored via pack rows,
never via engine changes) and to any new audit source that appears — those
plug into `v_legal_order_audit_timeline` as an additional `UNION ALL` branch
per the ADR-0094 addendum. Do not extend the engine to accommodate
country-specific behaviour; the guardrails above are non-negotiable.
