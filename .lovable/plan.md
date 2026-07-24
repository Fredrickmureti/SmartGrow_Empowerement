# Legal Orders / Garnishments — Continuation

## Verification of prior engineer's claims

I audited the DB and codebase directly against `.lovable/plan.md`. Every previously-claimed item is genuinely in place:

| Claim | Evidence | Verdict |
|---|---|---|
| Phase 1–5 (recipient master data, FSM guard, workspace, outbox, ADRs 0092–0094) | Migrations + `legal-orders-phase2..phase5*` tests present | Accepted |
| Phase 6 jurisdiction packs + ADR-0095 | `LegalOrderPacks.tsx` + `legal-orders-phase6-packs.test.ts` | Accepted |
| Phase 7 remittance batches, bank-file, settlement, bank-rec seam, nightly auto-satisfy, statement RPC + ADR-0096 | All 8 RPCs live (`legal_order_build/generate/settle/cancel/match_batch/auto_satisfy/recipient_statement/running_balance`); `pg_cron` job `legal-orders-auto-satisfy-nightly` present; UI pages `LegalOrderRemittanceBatches`, `LegalOrderRemittanceBatch` mounted; `legal-orders-phase7-remittance-cycle.test.ts` present | Accepted |
| Phase 8 backend — audit timeline view, statutory-report definitions table, running-balance RPC + ADR-0097 | View, table, RPC all exist; `LegalOrdersAudit.tsx` mounted; `legal-orders-phase8-audit.test.ts` present; ADR-0097 in `docs/adr/` | Accepted |
| Pack-seeded statutory definitions | `SELECT count(*) FROM legal_order_statutory_report_definitions WHERE organization_id IS NULL` → **0 rows** | **Pending** |
| ADR-0094 extension for audit-projection contract | ADR-0094 unchanged; no audit-projection section | **Pending** |

No superficial patches, no regressions found. The last two items are the only genuine gaps to close the roadmap.

## Remaining work

### Step 1 — Seed platform statutory-report definitions (migration)

Insert two pack-neutral rows into `public.legal_order_statutory_report_definitions` with `organization_id = NULL` (platform scope), idempotent via the `(organization_id IS NULL, jurisdiction_code, report_code)` partial unique index. Both are country-agnostic aggregates the reporting centre already knows how to render — no engine or UI change needed.

- `report_code = 'legal_orders_outstanding_by_recipient'`
  - `name`: "Legal Orders — Outstanding by Recipient"
  - `frequency`: `monthly`
  - `definition` JSON: source = `legal_recipient_outstanding` aggregate; grouped by `recipient_id`; columns = recipient name, jurisdiction, orders_open, total_owed, accrued, remitted, outstanding.
- `report_code = 'legal_orders_remittance_activity'`
  - `name`: "Legal Orders — Remittance Activity"
  - `frequency`: `monthly`
  - `definition` JSON: source = `legal_order_remittance_batches` × `legal_order_remittance_batch_lines`; filter `status='settled'` in period; columns = batch_number, recipient, settled_payment_date, planned_total, actual_total, bank_txn_matched.

Scope for pack rows: `jurisdiction_code = NULL` on both (platform default). Country-specific report definitions remain the responsibility of individual localisation packs and are out of scope for this closing step. This preserves the "country agnostic engine, pack-driven country behaviour" guardrail.

### Step 2 — Extend ADR-0094 with the audit-projection contract

Append a new section to `docs/adr/0094-legal-order-event-integration.md` documenting `v_legal_order_audit_timeline` as the canonical read-projection for legal-order history:

- Purpose, invoker-scoped security model, and the five source branches (lifecycle events, audit log, dispatch log, batch created/settled/cancelled).
- Row shape `(organization_id, legal_order_id, occurred_at, entry_kind, action, actor_user_id, details, source_row_id, source_table)`.
- Extension rule: new audit sources plug in as an additional `UNION ALL` branch — consumers must not add another view.
- Non-writer contract: the projection is read-only; state changes continue to route through the FSM writers listed in ADR-0094 §6.

### Step 3 — Verification

- Re-run the DB probe: `SELECT count(*) FROM legal_order_statutory_report_definitions WHERE organization_id IS NULL` returns `2`, both rows visible to `authenticated`.
- Re-run `bunx vitest run src/test/architecture/legal-orders-phase8-audit.test.ts` and Phase 7 test — expect green.
- Update `.lovable/plan.md`: flip both pending rows to Accepted, mark the roadmap complete, remove the duplicated Phase 7 step 2 block that's currently repeated in the file.

## Out of scope (intentionally)

The roadmap is otherwise complete. No new phases are needed; every stage of the lifecycle (Authority → Order → Payroll → Payslip → GL → Liability → Remittance batch → Bank file → Settlement → Bank rec → Audit → Auto-satisfy → Historical balance → Reports) has a single source of truth and an architecture test. If a future gap is discovered during Step 3 verification I'll surface it before closing out rather than silently expanding scope.

## Technical notes

- Both new rows go in a single migration; no GRANT/RLS work needed (table already ships them). Use `ON CONFLICT DO NOTHING` against the platform partial unique index so re-running the migration is safe.
- ADR-0094 edit is doc-only, no code impact.
- No new tables, no new RPCs, no UI changes.
