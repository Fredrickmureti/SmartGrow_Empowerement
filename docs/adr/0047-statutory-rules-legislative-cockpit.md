# ADR 0047 — Statutory Rules as a Legislative Cockpit, separated from Custom Deduction Types

- **Status:** Accepted
- **Date:** 2026-06-30
- **Supersedes:** —
- **Related:** ADR-0041 (Payroll Readiness operational workspace), pack-lifecycle migrations (`localization_packs`, `pack_versions`, `pack_upgrade_proposals`, `pack_rule_conflicts`), 2026-06-13 payroll-localization conformance audit.

## Context

Payroll → Compliance → Statutory Rules is the platform's legislative and compliance engine. It is consumed far beyond Payroll: Finance, Accounting, Remittances, Tax Certificates, Returns, Reporting, GL generation, and Payslips all derive from the same effective-dated rule rows. The backend already implements an enterprise-grade pack lifecycle (authoring → publish → install-atomic → upgrade proposals → conflict resolution → effective-dated supersession → rollback), pinned versions per tenant, an immutable `pack_audit_log`, and per-row schema validation against `pack_rule_type_schemas`.

The tenant-facing page at `/hr/payroll/configuration/statutory-rules` was a flat CRUD over `payroll_statutory_rules`. It hid the legislative model the platform actually implements: no provenance badge ("Pack" / "Tenant override" / "Pending upgrade" / "Conflict"), no effective-date timeline, no downstream-impact view, no upgrade inbox at the rule, and it co-located **statutory rules** (pack-owned, legislative) with **custom deduction types** (tenant-owned, operational) — two concepts with different governance, lifecycles, and downstream consumers.

## Decision

1. **Statutory Rules becomes a Legislative Cockpit**, not a CRUD page. It is anchored on three SECURITY INVOKER read models that join the existing pack pipeline into the tenant's rule rows:
   - `v_payroll_statutory_rule_status` — provenance + divergence (`pack_clean | tenant_override | pending_upgrade | conflict | tenant_authored`).
   - `v_payroll_statutory_rule_consumers` — downstream blast radius (payslip lines, GL account roles, remittance schedules, salary rules, certificate/return templates).
   - `v_payroll_statutory_rule_timeline` — effective-date history per `rule_code` with supersession edges.

2. **The workspace exposes one tab per business question**: Rules (with a Provenance column + Impact action per row), Upgrade Inbox, Conflicts, Timeline, Audit. A summary header surfaces installed pack version, pending upgrade count, unresolved conflicts, and tenant override count.

3. **Custom Deduction Types is split into its own workspace** at `/hr/payroll/configuration/deduction-types`. It owns the `payroll_rule_types` CRUD and its `CustomDeductionTypeDialog`. The Statutory Rules page no longer authors deduction types; it only reads their codes to populate the rule-editor's type picker so legacy rows round-trip cleanly.

4. **No engine changes.** `compute-payroll`, `generate-tax-certificate`, `generate-statutory-return`, `generate-payslip-pdf`, `post-payroll-gl`, and `post-remittance-payment` continue to consume `payroll_statutory_rules` dispatched on `computation_method` (never on `rule_code`). The cockpit is purely additive: read models + UI consolidation.

5. **Architectural guardrails** are pinned via `src/test/architecture/statutory-rules-vs-custom-deduction-types.test.ts`. A future refactor cannot collapse the two surfaces back into one page without explicitly removing the guardrail (and updating this ADR).

## Consequences

- The legislative lifecycle (authoring → publish → install → upgrade → conflict → rollback) is now visible on the same screen where a tenant administrator answers "what statutory rules apply, where did they come from, and what is coming?".
- Provenance is rendered at the row, so divergence from the installed pack snapshot is no longer invisible.
- Downstream impact (W4) is reachable in one click via `StatutoryRuleConsumersDrawer`, backed by `v_payroll_statutory_rule_consumers`.
- Tenant-owned non-statutory configuration (custom deduction types) has its own URL, its own permission gate (`manageStatutoryRules`), and its own delete-confirmation flow — without polluting the pack-governed cockpit.
- The `useRuleTypes` hook is single-sourced at `@/hooks/usePayrollRuleTypes`; the `CustomDeductionTypeDialog` is reusable from anywhere that needs to author a tenant deduction type.
- No new writes are introduced anywhere. All new surfaces are SECURITY INVOKER views or pure presentation.

## Non-goals

- Re-architecting the pack pipeline itself — the 2026-06-13 conformance audit already classifies it Enterprise Grade with zero country leaks.
- Building a simulation UI in this ADR — `compute-payroll(dry_run=true)` and `RuleSimulator` remain available but their integration into the cockpit is tracked separately.
- Touching `payroll_rule_types` storage shape — only its ownership and routing are clarified.
