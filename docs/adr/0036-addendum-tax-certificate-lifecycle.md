# ADR-0036 Addendum — Tax Certificate Lifecycle, Provenance & Submission

Status: Accepted · 2026-06-30 · Extends ADR-0036

## Context

ADR-0036 made certificate generation country-agnostic and template-driven.
It did not specify what happens *around* the act of issuance: how the
system learns a certificate has gone stale after a retroactive payroll
correction, who is permitted to issue, how issuance relates to statutory
submission, and what audit trail proves the chain end-to-end.

## Decision

1. **Lifecycle event ledger.** `payroll_tax_certificate_events` is the
   sole audit log for certificate state changes. Triggers on
   `payroll_tax_certificates` write `generated` / `superseded`;
   `download-tax-certificate` writes `downloaded`; the submission
   trigger writes `submitted` / `accepted` / `rejected`; the staleness
   sweep writes `marked_stale`.
2. **Provenance snapshot.** Every issued certificate stores
   `provenance = { run_ids, max_committed_at, max_correction_at,
   ytd_rollup_hash }`. `payroll_mark_stale_certificates(fy)` compares
   this against current payroll state. Triggers on `payroll_runs`
   (status / reversal / posted_at) and `payroll_correction_adjustments`
   re-evaluate affected certificates automatically.
3. **Permission gate.** Issuance is gated on `payroll.write`, not
   `financials.write`. Self-service download by the certificate's
   employee remains the only bypass.
4. **Pack-status single source of truth.** Both the hook and the edge
   function read `v_org_active_localization_pack`. The hook and engine
   cannot disagree about which pack is "active".
5. **Submission lifecycle.** `payroll_tax_certificate_submissions`
   links a certificate to the `payroll_return_runs` filing that
   carried it. `record-return-filing` writes the join on terminal
   return states; the table's trigger fans into the lifecycle ledger.
6. **Employer reconciliation.** `payroll_certificate_reconciliation`
   returns the cert/return/remittance variance per template per FY.
   Non-zero variance is a `payroll_diagnostics` signal, not a UI
   warning shoved into a toast.

## Invariants (enforced by tests)

- `src/test/architecture/tax-certificate-lifecycle.test.ts` pins the
  permission gate, the canonical pack view, the download event log,
  and the submission join.
- Architecture guard prevents reverting issuance to `financials.write`.

## Out of scope

- Marketplace publishing of certificate templates (ADR-0010).
- Engine `computation_method` extensions.