# ADR 0056 — Localization Publisher Parity (deferred P2 track)

**Status:** Accepted — future track (2026-07-01)
**Owners:** Platform / HR-Payroll
**Relates to:** ADR 0010 (pack versioning + tokens)

## Context

The Localization Publisher audit (June 2026) established that packs must
be authored end-to-end without SQL. P0, P1, P3, and P4 shipped:

- 8-state return-run machine with `payroll_return_transition` as the sole
  writer; `pack_return_run_audit` → `business_event_outbox` fan-out.
- Publisher-facing editors for grants, tokens, garnishments, bank exports,
  statutory authorities, and pack requirements.
- Outbox consumer `process-localization-outbox` for pack + return events.
- Architecture guards: editor coverage, state machine, effectivity
  binding, resolver-only engine reads.
- Publish-time lint gate in `publish-localization-pack-version` (existing).

Four workstreams remain that are structurally sound to defer because
they require multi-week design work and none of them block a publisher
from shipping a working country pack today.

## Decision

Track them here so a later slice picks them up with the constraints
already fixed.

### P2.a — Dependency graph

Publishers need to see which rules/tokens are consumed by which
templates, returns, and certificates before deleting or renaming one.

**Constraints for the future implementation**

- Sourced from `business_event_outbox` (rule.published, token.retired,
  template.updated). No live scans of `localization_pack_*` tables.
- Graph edges typed by kind: `token→template`, `rule→remittance`,
  `template→return`.
- Read-through cache invalidated by `pack.upgraded`; no separate
  refresh trigger.

### P2.b — Semantic diff

`PackDiffView` currently shows JSON-shaped changes. Publishers need an
entity-aware diff: "PAYE bracket 3 upper bound increased from 32,333 to
36,667, effective 2026-07-01".

**Constraints**

- Diff engine reads `pack_versions.snapshot` (already immutable).
- One renderer per `rule_type` × `computation_kind`, registered
  alongside its JSON Schema in `pack_rule_type_schemas`. No renderer →
  fall back to today's JSON diff.
- Diff output feeds the `pack_upgrade_proposals` UI so tenants see
  business impact, not raw JSON.

### P2.c — End-to-end pack simulator

Before publishing, the publisher must be able to dry-run the pack
against a synthetic employee fixture and see:

- Every payslip line the pack would generate.
- Every statutory rule that fired vs skipped, with reason.
- Every template that would render, with unresolved tokens surfaced.
- Every return that would be filable, with reconciliation status.

**Constraints**

- Reuses `compute-payroll` in dry mode (no writes) — the simulator
  MUST NOT reimplement the engine.
- Fixture library seeded per country in `pack_test_fixtures`
  (single-employee, family, high-earner, terminated, etc.).
- Result rendered as a downloadable audit report; failures block
  publish unless overridden with `simulator_ack_reason` (recorded in
  `pack_audit_log`).

### P2.d — 4-eyes review + certification

Publisher partners self-certify today. Enterprise deployments will
require a second reviewer.

**Constraints**

- `pack_versions.state` extended: `draft → pending_review → certified
  → published → superseded`.
- Review approval writes to `pack_audit_log` and gates the publish
  edge function.
- Reviewer role is a `pack_publisher_grants` row with
  `capability='review'` — no new table.

## Consequences

**Positive**

- Later track has fixed integration points; no risk of divergent
  designs.
- The current architecture is not blocked: a publisher can already
  ship a country pack that produces correct payroll and returns.

**Deferred cost**

- Until P2.a lands, publishers rely on the pack Health tab and the
  `pack_rule_conflicts` view to spot dependency issues.
- Until P2.c lands, mis-computations are only caught in staging.
- Until P2.d lands, publisher certification is procedural, not
  enforced by the platform.

## Out of scope

- Public pack marketplace (separate ADR when we have partners).
- Multi-language editor UI (handled by the platform i18n track).
- Non-payroll pack schema validation (accounting taxonomies — follow-on
  to ADR 0010).
