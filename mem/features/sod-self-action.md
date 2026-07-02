---
name: SoD self-action framework
description: Cross-module Segregation-of-Duties controls — self-approval/self-benefit guards, policy registry, overrides
type: feature
---
Wave G2 enforces SoD at the database layer via `governance_assert_not_self` / `governance_assert_not_subject` helpers, called from `BEFORE UPDATE` triggers (`sod_<table>_guard`) on every approval surface — payroll_runs, leave/timesheets/loans/contracts/compensation, bills, payments, JEs, POs, expenses, refunds, credit notes (sales + vendor), stock adjustments/transfers. Per-org `self_action_policy(action_key, mode, applies_to_role)` with default `block`; owner/super_admin can issue one-time co-signed `self_action_overrides` (immutable, single-use, 1h expiry). All refusals and override consumptions land in `audit_logs`. Add new actions via the catalogue at `src/lib/governance/selfActionCatalogue.ts` plus a matching `sod_<table>_guard` trigger; coverage is locked by `src/test/architecture/sod-coverage.test.ts`. Errors raise `SQLSTATE 42501` with HINT `GOV_SELF_ACTION` / `GOV_APPROVER_REQUIRED` / `GOV_MISSING_PERMISSION`; UI parses via `parseGovernanceError`.
