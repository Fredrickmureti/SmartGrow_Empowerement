# Plan

Two distinct pieces of work, in order. No code changes until the audit verdicts are approved.

## 1. Connect Supabase project `AccrualFlowCorporation`

Straightforward integration step (not part of the audit):

- Link the existing Supabase project `AccrualFlowCorporation` to this Lovable project.
- Verify `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the `VITE_*` counterparts are populated.
- Regenerate `src/integrations/supabase/types.ts` against the linked project.
- Sanity check: one `supabase--read_query` against `information_schema` to confirm the link, no data mutations.

No schema, RLS, or business logic changes in this step.

## 2. POS refund/reversal architecture audit (read-only)

Deliverable is a written verdict document, not code. Structured in phases so each phase's findings are cited with `file:line` evidence from the repo.

### Phase A — Domain modelling verdict
Determine what business event "Reverse" in POS History actually is today vs. what it should be. Map current UI + code to the canonical set: Void / Cancel / Refund / Return / Reversal / Exchange / Store Credit. Cite the components, RPCs, and DB tables involved. Compare against SAP Retail / Oracle Retail / D365 Commerce / LS Central / Lightspeed / Square / Shopify POS / Odoo POS conventions and state which model our code is closest to and where it diverges.

### Phase B — Runtime context propagation verdict (root cause of "Company not selected")
Trace how organization / business / store / warehouse / register / shift / cashier / permissions / printer / taxes / currency / pricing profile / hardware profile are established when a register opens, and how each is read at refund time. Identify every place the refund path re-queries "current company" instead of inheriting from the terminal session envelope. Explicit finding: is `Company not selected` a missing parameter, or a violation of single-source-of-truth runtime context? Evidence-based verdict.

### Phase C — Authorization model verdict
Audit the Manager PIN + `Override denied` path. Determine whether authorization is policy-driven (amount / tender / receipt age / category / role / reason code) or a hardcoded PIN gate. Verdict on enterprise-grade scalability.

### Phase D — Engine-by-engine integration verdict
For the refund lifecycle, audit each engine touched and record ownership (state / execution / validation / authorization / rollback):
Payment · Inventory · Warehouse · Finance (immutable journals vs. mutation) · Tax · Receipt · Audit · Sync · Reporting · Analytics · Notifications.
Flag duplicated implementations, frontend/backend disagreements, and reconstructed-vs-inherited context.

### Phase E — Offline behaviour verdict
Determine what refund operations must survive network loss and which currently depend on online RPCs that could be local.

### Phase F — Consolidated verdicts
One-line verdict + evidence for each of the 11 questions in the brief (runtime, authz, refund modelling, payment reversal, inventory, warehouse, accounting, audit integrity, offline, event boundaries, "Company not selected" as symptom vs. cause).

### Phase G — Proposed remediation plan
Only after verdicts. High-level target architecture (session envelope as SSOT, policy-driven authz, reversing-journal finance, event-driven refund saga, returns disposition workflow), sequenced into implementation stages with rollback safety. Each stage will come back through plan mode before any code is written.

## Technical notes

- Audit is 100% read-only: `code--view`, `rg`, `supabase--read_query`, subagent `acp_subagent--explore` for parallel traces.
- No files edited, no migrations, no RPC changes during phases A–F.
- Phase G output is a follow-up plan, not code.
- Expected surface area to trace: `src/apps/pos/**`, `src/services/pos/**`, `src/services/events/**`, `src/features/sales/**` (refund/reversal/credit-notes/returns/payments), `electron/hardware/payment/**`, `supabase/functions/**`, RPCs and RLS on `payments`, `sales_returns`, `credit_notes`, `invoices`, `pos_*` tables.

## What I need from you to start

Approve this plan and I will (1) connect Supabase, then (2) begin Phase A and deliver verdicts phase by phase before proposing any implementation.
