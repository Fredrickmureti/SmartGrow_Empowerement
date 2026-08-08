# Proforma Invoice Domain — Authoritative Status (2026-08-09)

Roadmap source: `.lovable/plan/proforma-invoice-architecture-audit-verdict-and-convergence-2026-08-08.md`
Verdict record: `docs/audit/2026-08-08-proforma-domain-verdict.md`

## Current phase

Phase G (verification and documentation) — **complete**. The convergence roadmap
(A–G) is finished; the domain is production-ready and no phase is left partial.

## Fully implemented and verified

- **A. Numbering** — `get_next_proforma_number(_org_id, _business_id)` is business-scoped,
  takes `pg_advisory_xact_lock`, uses the business `proforma_prefix` (fallback `PI-`).
  Verified in DB: unique index `ux_proforma_invoices_number (organization_id, business_id, proforma_number)`.
- **B. Security** — per-command RLS on `proforma_invoices` and `proforma_invoice_items`
  using the 4-arg `user_has_module_permission(..., 'sales', ...)`, business-scoped,
  with explicit GRANTs for `authenticated` / `service_role`.
- **C. Lifecycle** — `set_proforma_status_atomic` state machine, `proforma_status_write_guard`
  rejecting direct status writes, `proforma_freeze_after_convert` freezing financial
  fields and blocking deletion of converted proformas. Status CHECK verified in DB:
  `draft|sent|accepted|rejected|expired|cancelled|converted`. Converter's phantom
  `viewed`/`approved` guard removed. Audit rows emitted on create/status/convert/delete.
- **D. Atomic create** — `create_proforma_atomic(p_header, p_items)` allocates the number,
  inserts header + lines in one transaction and **recomputes** line tax, discount,
  subtotal and total server-side. Hook no longer does two-step client inserts.
- **E. Frontend convergence** — `useProformaInvoices` gates every mutation on
  `manageSales` and logs to `useAuditLog`; status changes route through
  `setProformaStatus`. List-row Send / Convert / Cancel / Delete wrapped in
  `PermissionGate`; Edit/Delete hidden for `converted`. `ProformaCreatePage` now uses
  the canonical `computeLine` / `computeTotals` helpers (discount-aware, matching the
  server recompute). Stale `ProformaRecordPage` header comment corrected.
- **F. Expiry** — `expire_overdue_proformas()` scheduled nightly via
  `cron.schedule('expire-overdue-proformas', '15 1 * * *', ...)`.
- **G. Verification** — `src/__tests__/architecture.proforma-domain.test.ts` (6 tests)
  asserts no accounting/inventory leak and enforced atomic RPC usage;
  `src/test/documents/sales-proforma-snapshot.test.ts` (7 tests) green.
  `tsgo --noEmit`: clean. Docs updated: `docs/sales-audit.md` Proforma section and the
  dated verdict file.

## Pending

Nothing pending inside the Proforma domain. Deliberately out of scope (recorded in the
verdict, do not "fix" without a new decision): no AR/GL/tax/inventory effect, no
payment-against-proforma, no second PDF path, no country-specific behaviour.

Known non-blocking observation for whoever picks up finance-wide work: the project
linter reports a large pre-existing backlog of `Security Definer View` findings across
the database. Unrelated to Proforma; needs its own scoped phase.

## Instructions for the next agent

1. **Verify before building.** Confirm, don't assume:
   - `select pg_get_functiondef(oid) from pg_proc where proname in
     ('create_proforma_atomic','set_proforma_status_atomic','get_next_proforma_number',
      'convert_proforma_to_invoice_atomic','expire_overdue_proformas');`
   - triggers on `proforma_invoices` include the status guard and post-convert freeze;
   - `ux_proforma_invoices_number` exists; `cron.job` has `expire-overdue-proformas`;
   - `bunx vitest run src/__tests__/architecture.proforma-domain.test.ts` and
     `bunx tsgo --noEmit` are green.
   Fix any drift found before moving on.
2. **Then resume chronologically.** The next logical milestone after Proforma in the
   Sales lifecycle sequence (Estimate → Proforma → Sales Order → Invoice → Delivery →
   Settlement) is the **Sales Order domain audit and convergence**: apply the same
   checklist used here — atomic create RPC with server-side totals, business-scoped
   locked numbering with a unique constraint, per-command permission-scoped RLS on
   header and lines, an enforced status state machine with audit logging, freeze/delete
   guards once downstream documents exist, and an architecture guard test.
3. **Do not** start unrelated areas (warehouse, payroll, POS) while that milestone is
   open, and do not leave a domain half-converged.
