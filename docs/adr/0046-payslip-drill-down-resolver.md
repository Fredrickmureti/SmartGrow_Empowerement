# ADR 0046 — Payslip Drill-down Resolver

**Status:** Accepted — 2026-06-29
**Owners:** HR-Payroll / Platform
**Relates to:** ADR 0010 (localization-pack versioning), ADR 0036
(country-agnostic payroll completion), ADR 0045 (correction delta
engine).

## Context

Phase 4 of the payslip audit asked: *can every amount on a payslip be
traced back to the business record that produced it?* P1–P3 made the
data traceable:

- **P1** — every `payslip_lines.source` row now carries a typed
  `input_ref` (kind + ids) emitted by the engine through the shared
  `buildInputRef` helper.
- **P2** — payslips carry a country-agnostic header model plus an
  append-only lifecycle journal.
- **P3** — correction visibility banners surface "superseded by …" /
  "corrects …" relationships without statutory vocabulary.

The remaining gap was **navigation**. The explainer popover rendered a
read-only "Source: employment contract" line — the user had no way to
jump to the contract itself. Every previous attempt to add deep links
fell into the same trap: route lookup tables embedded in shared engine
code, or branches keyed off `rule_code === "PAYE"` to pick a target.
Both violate ADR 0036.

## Decision

Introduce a single, pure resolver — `src/lib/payroll/payslipDrillDown.ts`
— that maps `(InputRef, ResolveContext)` to a `DrillTarget | null`. The
resolver is the **only** place in the codebase that knows how to turn a
payroll provenance pointer into an in-app route.

### Boundaries

1. **The engine never imports the resolver.** It only ever stamps
   `input_ref` jsonb via `buildInputRef`. Engine code stays
   route-agnostic and country-agnostic.
2. **The resolver never imports the engine.** It is a pure module:
   no React, no Supabase, no fetch.
3. **Permission + mode resolution lives in the hook**
   (`usePayslipDrillDown`), not in the resolver. The hook reads
   `SelfServiceContext` and `usePermissions` and drops the target to
   `null` when the caller would not be allowed in. This keeps the
   resolver trivially unit-testable and lets the architecture test
   assert the country-agnostic invariant statically.
4. **The country-agnostic invariant is enforced by two tests**:
   `src/test/architecture/payslip-drill-down.test.ts` greps the
   resolver source for jurisdictional tokens and asserts every
   `InputRefKind` is handled; `src/test/payroll/payslip-drill-down.test.ts`
   verifies every generated URL also passes the regex.

### Mode contract

`mode: "admin"` returns `/hr/…` (or top-level `/expenses` for the
already-shared expense surface). `mode: "portal"` returns `/me/…`.
Sensitive kinds (`garnishment`, `statutory_rule`,
`termination_payout`, `salary_structure`, `benefit`) intentionally
return `null` in portal mode — the popover falls back to descriptive
text. New self-service viewers (e.g. an employee-side benefit screen)
unlock additional kinds without changing the engine.

### UI contract

`PayslipLineExplainer` consumes the hook and renders one of:

- a `<Link>` (admin or portal) when a target resolves and the
  permission check passes,
- the existing descriptive `<div>` ("Source: …") when no target is
  available or the permission is missing.

There is no third state. A null target is indistinguishable from "the
explainer never had an `input_ref`" — both gracefully degrade.

## Consequences

**Positive**

- One file owns the entire payroll → UI navigation map. Adding a new
  `InputRefKind` fails the architecture test until the table is
  updated, so the audit chain cannot regress silently.
- Sensitive payroll concepts (garnishments, statutory rules, exit
  payouts) have no portal route — there is no way for a self-service
  user to follow a link they shouldn't.
- The engine remains jurisdiction-neutral. The drill-down table is
  the only place the UI knows about per-kind destinations, and that
  table is grepped for statutory vocabulary on every CI run.

**Negative / cost**

- Adding a new ref kind now requires three coordinated edits
  (shared `inputRef.ts`, mirror in `src/lib/payroll/inputRef.ts`,
  resolver). The architecture test catches missed updates but the
  cost is real.
- Drill targets that depend on optional ids (`contract.contract_id`,
  `loan.loan_id`) silently fall back to descriptive text when the
  engine omits them. This is intentional — better than a dead link —
  but it does mean the engine has an implicit responsibility to
  populate the fields when navigation should be possible.

## Out of scope

- Dedicated self-service screens for contracts, benefits, and
  expenses. Those are tracked separately; when they ship, the
  resolver gains a portal branch with no engine changes required.
- Deep links inside the downloadable PDF payslip. The PDF remains a
  flat document; drill-downs are an in-app affordance only.
