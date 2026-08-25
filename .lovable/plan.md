I’ll first ground the audit in the repository and database evidence, then surface a no-code audit plan for approval.

CRM Domain Audit & Rework Contract

Audit date: 2026-08-25  
Scope: CRM pipeline, lead creation, stages, lifecycle RPCs, activities, branch/business isolation, history/outbox, and downstream Sales/Project/Reporting/Automation/AI consumers.  
Change control: No application code, schema, migrations, or data were changed.

---

1. Verdict

FACT: CRM is no longer merely a CRUD shell. The core lifecycle is now materially domain-guarded:

- Lifecycle fields are protected by a database write guard.
- Qualification, Won, Lost, Reopen, reassignment, and branch transfer have authorized `SECURITY DEFINER` RPCs.
- Terminal-state consistency is enforced by a database constraint.
- Stage and lifecycle changes write history and emit outbox events.
- Leads, stages, and activities have substantial organization/business/branch scoping.
- Conversion to Contact, Estimate, Sales Order, and Project is implemented through guarded RPCs rather than direct document inserts.

FACT: CRM is not yet a reliable end-to-end business-event-driven domain. The current state is better described as:

> A guarded lifecycle core surrounded by CRUD-managed supporting objects, with several broken hidden consumers and unresolved tenancy/reporting gaps.

The prior claim that Phases 0–4 are fully complete is not accepted.

The most important reasons are:

1. Three backend consumers are stale or broken:
   - Automation-created CRM activities omit mandatory `business_id`.
   - Scheduled CRM pipeline reports query the removed `company_name` field.
   - The AI assistant queries the removed `stage` field.

2. `crm_lead_items` remains a tenancy hole:
   - `business_id` is nullable.
   - There is no lead/business composite foreign key.
   - RLS derives access from the parent lead’s business, not the item row’s business.
   - Product/item references are not conclusively constrained to the lead’s business.

3. `crm_lead_history` has excessive table grants:
   - Both `anon` and `authenticated` have broad privileges, including privileges far beyond append/read requirements.
   - RLS currently limits row access, but the grant set violates least privilege and creates avoidable future risk.

4. CRM events are emitted but not yet business-operational:
   - CRM topics exist, but every inspected CRM topic currently has an empty `consumer_domains` list.
   - The outbox is therefore instrumentation and integration infrastructure, not yet a proven event-driven downstream workflow.

5. Reporting is not authoritative:
   - Pipeline, dashboard, export, scheduled report, and AI context derive state differently.
   - Monetary aggregation has no lead-level currency model or conversion strategy.
   - Client-side aggregation remains exposed to Supabase row limits.

Conclusion: The previous work established a credible architectural foundation, but implementation should resume at a P0 repair phase, not at the previously proposed Phase 5 feature work.

---

2. What CRM is supposed to own

CRM should own

STD + INFER: In this ERP, CRM should own:

- Lead and opportunity identity.
- Lead source and acquisition metadata.
- Qualification state.
- Pipeline and stage semantics.
- Opportunity ownership.
- Business and branch ownership.
- Expected revenue and probability.
- Expected close date.
- Won/Lost terminal outcomes.
- Lost reasons and explanatory notes.
- Follow-up activities and next-activity state.
- Lead/opportunity history.
- CRM business events.
- Conversion lineage to:
  - Contact/customer.
  - Estimate/quotation.
  - Sales order.
  - Project, where project delivery is legitimately sourced from an opportunity.

CRM should not own

STD + FACT: CRM should not directly own:

- Invoice posting.
- Payment allocation.
- Revenue recognition.
- General ledger posting.
- Project delivery execution.
- Inventory reservation or fulfillment.
- Commercial document numbering and fiscal validation.

FACT: The current implementation preserves this boundary. `crm_mark_won` changes CRM state and logs CRM history; it does not post an invoice or journal. Commercial documents are created only through separate conversion RPCs.

---

3. Actual CRM lifecycle

Current state machine

FACT: The database enum contains:

```text
new → qualified → proposition → won
  ↓         ↓            ↓
  └────────→ lost ←──────┘
```

The enforced transition function permits:

- `new → qualified`
- `new → lost`
- `qualified → proposition`
- `qualified → won`
- `qualified → lost`
- `proposition → qualified`
- `proposition → won`
- `proposition → lost`
- `won/lost → new` or `qualified`, only through governed reopen

Evidence: live definition of `_crm_assert_transition`.

Actual implemented flow

FACT:

1. Create
   - `useLeads` inserts directly into `crm_leads`.
   - The hook supplies organization, business, branch, descriptive data, and references.
   - Lifecycle authority fields are not supposed to be supplied by ordinary browser updates.

2. Qualify
   - `crm_qualify_lead` changes `new → qualified`.
   - It sets `type = 'opportunity'`.
   - It writes a system activity.

3. Move stage
   - `crm_move_stage` is the governed stage-movement path.
   - The React drag-and-drop UI calls the RPC rather than directly changing `stage_id`.

4. Mark Won
   - `crm_mark_won` validates access and transition.
   - Sets:
     - `status = 'won'`
     - `type = 'opportunity'`
     - `won_at = now()`
     - `lost_at = NULL`
     - `probability = 100`
     - active Won stage when one exists
   - Writes a system activity.

5. Mark Lost
   - `crm_mark_lost` requires either a lost reason or explanatory note.
   - Sets:
     - `status = 'lost'`
     - `lost_at = now()`
     - `won_at = NULL`
     - `probability = 0`
     - active Lost stage when one exists
   - Writes a system activity.

6. Reopen
   - A guarded reopen RPC exists.
   - The transition function only permits terminal records to return to `new` or `qualified`.

7. Reassign
   - `crm_reassign_lead` changes `assigned_to`.
   - It verifies that the assignee can access the lead’s business.

8. Branch transfer
   - A governed branch-transfer RPC exists.
   - Branch changes are treated as business events rather than ordinary inline edits.

9. Value update
   - Expected revenue remains a descriptive/CRM-field update path.
   - A `crm.lead.revalued` topic is registered.

Lifecycle gap

FACT: `proposition` is part of the enum and state machine, but no public RPC currently transitions an opportunity into `proposition`.

Consequence: `proposition` is structurally reachable according to `_crm_assert_transition` but operationally unreachable through the public CRM command surface.

---

4. Business-event map

FACT: The following CRM topics are registered in `business_event_topics`:

| Topic | Registered meaning | Current consumer domains |
|---|---|---:|
| `crm.lead.qualified` | Lead qualified into opportunity | none |
| `crm.lead.stage_changed` | Opportunity moved between stages | none |
| `crm.lead.revalued` | Expected revenue changed | none |
| `crm.lead.reassigned` | Ownership changed | none |
| `crm.lead.branch_transferred` | Branch ownership changed | none |
| `crm.lead.won` | Opportunity marked won | none |
| `crm.lead.lost` | Opportunity marked lost | none |
| `crm.lead.reopened` | Terminal opportunity reopened | none |
| `crm.lead.archived` | Lead archived | none |

Event interpretation

FACT: CRM has event production infrastructure.

FACT: The registered topics currently declare no downstream consumer domains.

INFER: CRM is therefore event-instrumented, but not yet fully event-driven. A truly event-driven domain would have durable consumers or explicit integration handlers for cases such as:

- Notify owner on reassignment.
- Notify branch manager on transfer.
- Trigger follow-up automation after qualification.
- Start customer onboarding after Won.
- Update forecast/read models after revaluation.
- Notify stakeholders after Lost.
- Create delivery intake after a qualifying Won.

Missing event

FACT + INFER: No `crm.lead.created` topic was found. Lead creation is an important acquisition and attribution event and should eventually be represented if downstream analytics, assignment, or automation depend on it.

---

5. Actual repository architecture

Browser/UI layer

FACT:

- Pipeline board: `src/pages/crm/CRMPipeline.tsx`
- Dashboard: `src/pages/crm/CRMDashboard.tsx`
- Activities: `src/pages/crm/CRMActivities.tsx`
- Lead form: `src/components/crm/LeadForm.tsx`
- Lead details/conversion menu: `src/components/crm/LeadDetailsDialog.tsx`
- Lead product items: `src/components/crm/LeadItemsEditor.tsx`
- Stage settings: `src/components/crm/StageSettingsDialog.tsx`
- CRM hooks: `src/hooks/crm/*`

The UI uses direct Supabase reads for most data and calls RPCs for important lifecycle transitions.

Hook/command layer

FACT: `src/hooks/crm/useLeads.ts` now separates:

- Browser-managed descriptive fields.
- RPC-managed lifecycle operations.

The architecture tests verify that application code does not directly update protected lifecycle fields such as:

- `status`
- `stage_id`
- `won_at`
- `lost_at`

Database domain layer

FACT: The live database contains:

- Lifecycle transition function.
- Lead access assertion.
- Lifecycle write guard.
- Lead scope guard.
- Assignee guard.
- History writer.
- History immutability guard.
- Stage deactivation guard.
- Activity branch derivation.
- Outbox event emission.

Relevant live internal functions include:

- `_crm_assert_lead_access`
- `_crm_assert_transition`
- `_crm_lead_lifecycle_write_guard`
- `_crm_lead_scope_guard`
- `_crm_lead_assignee_guard`
- `_crm_lead_history_record`
- `_crm_lead_history_immutable`
- `_crm_emit_lead_event`
- `_crm_activity_branch_from_lead`
- `_crm_stage_deactivation_guard`

Downstream consumers

FACT: Repository consumers include:

- Contact profile lead history.
- Originated-from-lead badges.
- Project overview source-lead display.
- Quick statistics.
- CRM dashboard and pipeline exports.
- Scheduled reports.
- Process automation.
- AI assistant context.
- Estimate/Sales Order/Project conversion RPCs.

This consumer inventory is broader than the original UI-centered audit scope.

---

6. Confirmed defects

P0 — Broken downstream consumers

6.1 Automation cannot create CRM activities

FACT: `process-automation` inserts into `crm_activities` without `business_id`:

- `supabase/functions/process-automation/index.ts:294-303`

FACT: `crm_activities.business_id` is mandatory.

Consequence: Any automation action that creates a CRM activity will fail at runtime.

---

6.2 Scheduled CRM pipeline report uses stale schema

FACT: `process-scheduled-reports` queries `crm_leads.company_name`:

- `supabase/functions/process-scheduled-reports/index.ts:495-501`

The current CRM model resolves company identity through `company_contact`, not the old free-standing `company_name` column.

Consequence: The scheduled CRM pipeline report is stale and expected to fail or omit the intended dataset.

---

6.3 AI assistant uses stale lead schema

FACT: `ai-assistant` queries the removed `stage` column:

- `supabase/functions/ai-assistant/index.ts:554-560`

The current model uses `stage_id` joined to `crm_stages`.

Consequence: CRM context retrieval for the AI assistant is stale and expected to fail when that path executes.

---

P0 — Lead item tenancy and integrity

6.4 `crm_lead_items.business_id` is nullable

FACT:

- `crm_lead_items.business_id UUID` is nullable in the original table migration.
- No later migration was found that makes it mandatory.

Evidence:

- `supabase/migrations/20260214230719_034e2096-e00c-469c-8ba6-fc5cd6e8dc50.sql:43-49`

---

6.5 Lead items lack the lead/business composite foreign key

FACT: `crm_lead_items` references the lead but does not use a `(lead_id, business_id)` composite foreign key.

Consequence: The database cannot guarantee that an item row’s business equals its parent lead’s business.

---

6.6 Lead item RLS and row business can disagree

FACT: The current lead-item policy checks access through the parent lead’s business and organization. It does not require `crm_lead_items.business_id = crm_leads.business_id`.

Consequence: If a malformed row is inserted through a privileged or future code path, its stored business dimension can disagree with the business used for RLS.

---

6.7 Product references are not fully tenant-safe

FACT: The item editor selects from browser-loaded products, but client-side filtering is not a database constraint.

INFER: A composite product/business reference or equivalent database assertion is required to prevent a lead in Business A from referencing a product owned by Business B.

---

P0/P1 — Privilege defects

6.8 `crm_lead_history` grants are excessive

FACT: Live catalog inspection shows broad privileges on `crm_lead_history` for both `anon` and `authenticated`, including DML and maintenance-level privileges.

RLS currently constrains row visibility, and write policies are absent, but the grants are not least-privilege.

Required direction:

- `anon`: no privileges.
- `authenticated`: narrowly scoped read only, if history is user-visible.
- Inserts should remain server/trigger-owned.
- No ordinary role should have update/delete/truncate-style privileges.

---

6.9 Stage administration is too broad

FACT: Stage create/update/delete policies are based on `sales.write`.

FACT: The base permission fallback grants sales write access to both `accountant` and `staff`.

INFER: If ordinary sellers receive the `staff` role, they can alter pipeline semantics, including Won/Lost terminal flags.

Required direction: Pipeline-stage configuration should require a dedicated sales-administrator or pipeline-administration permission, not ordinary sales write access.

---

P1 — Lifecycle defects

6.10 `proposition` is unreachable

FACT: No public RPC currently transitions a lead to `proposition`.

Required resolution: Either:

- Add a governed `crm_move_to_proposition` operation, or
- Remove `proposition` from the enum/state machine if it is not a real business state.

Keeping an unreachable state creates misleading reporting and future migration risk.

---

6.11 Assignment validates business but not branch eligibility

FACT: `crm_reassign_lead` verifies that the assignee can access the lead’s business.

GAP: The RPC does not visibly verify that the assignee can access the lead’s branch.

INFER: In a branch-scoped ERP, assigning an opportunity to a user who cannot access that branch can create an inaccessible or operationally ambiguous ownership state.

---

P1 — Reporting defects

6.12 Pipeline state is derived inconsistently

FACT:

- Pipeline export derives status from `won_at`/`lost_at`.
- Dashboard calculations use stage flags.
- Database authority is the `status` enum plus terminal timestamps.
- Scheduled reporting uses a stale schema.

Consequence: Different surfaces can classify the same lead differently if stage configuration and status diverge.

---

6.13 Monetary reporting has no currency authority

FACT: CRM leads store `expected_revenue` but no lead-level currency was found in the audited lead contract.

Consequence: Multi-currency businesses can sum values in different currencies as if they were one base currency.

---

6.14 Client-side aggregate queries are exposed to row limits

FACT: CRM dashboard/pipeline calculations are performed in the browser over queried rows.

FACT: Supabase/PostgREST queries are subject to row limits.

Consequence: Large tenants can receive incomplete dashboard totals without an explicit pagination or server-side aggregation strategy.

---

7. Security / tenant / business / branch isolation defects

Confirmed strengths

FACT:

- `crm_leads`, `crm_stages`, and `crm_activities` have organization and business dimensions.
- Activities have branch derivation from the parent lead.
- Lead-to-stage composite constraints prevent ordinary cross-business stage references.
- Activity-to-lead composite references include organization and business.
- Branch-transfer and lead-scope guards exist.
- RLS policies are present for the core CRM tables.
- Client branch filtering is no longer the only branch control for leads and activities.

Remaining defects

7.1 Lead items remain the major isolation exception

FACT: The item table does not have the same mandatory business/composite-reference posture as activities.

Severity: Critical for a multi-business ERP.

---

7.2 History grants violate least privilege

FACT: `crm_lead_history` grants are broader than necessary for `anon` and `authenticated`.

Severity: Critical as a hardening defect, even though current RLS limits practical row exposure.

---

7.3 Stage mutation permission is operational, not administrative

FACT: `sales.write` can modify stages.

Severity: High, because changing terminal flags changes lifecycle and reporting semantics across the business.

---

7.4 Branch-aware ownership is incomplete

FACT: Assignee validation checks business membership, not clearly branch access.

Severity: Medium/High depending on whether branch access is intended to constrain sales ownership.

---

8. Accounting boundary

FACT: The accounting boundary is currently sound.

- Won does not create an invoice.
- Won does not recognize revenue.
- Won does not post a journal.
- Estimate/Sales Order creation is optional and conversion-based.
- Accounting remains downstream of commercial document confirmation/posting.

STD: This matches normal ERP design:

```text
Opportunity Won
    ≠ Invoice Posted
    ≠ Revenue Recognized
    ≠ Journal Posted
```

INFER: This boundary should be preserved. Any future automation from Won to commercial documents should be implemented as an explicit, idempotent handoff with its own authorization and failure handling.

---

9. CRM → Sales relationship

FACT: CRM can originate downstream commercial records.

The supported relationship is closer to a star than a mandatory chain:

```text
                        ┌→ Contact/Customer
                        │
Lead / Opportunity ─────┼→ Estimate / Quotation
                        │
                        ├→ Sales Order
                        │
                        └→ Project
```

FACT: Conversion is not an unavoidable sequence:

```text
Lead → Estimate → Sales Order → Project
```

Instead, a Won lead can act as the origin for one or more downstream records.

Conversion controls

FACT:

- Conversion paths are RPC-based.
- The UI exposes conversion actions for terminal Won opportunities.
- Downstream records retain source-lead lineage.
- Unique constraints/idempotency controls were found for conversion relationships.

Defects

FACT: Lead items can be used as commercial intent, but their business/product integrity is not yet database-safe.

INFER: Lead items should not feed Estimates or Sales Orders until the following are enforced:

- Mandatory item `business_id`.
- Lead/business composite FK.
- Product/business validation.
- Currency and price-list authority.
- Clear quantity/UOM semantics.

---

10. CRM → Project relationship

FACT: Projects can directly reference a source lead.

FACT: Project creation is structurally independent of CRM; CRM is not required before Project.

STD: Many ERPs hand off delivery work from a confirmed Sales Order rather than directly from an opportunity:

```text
Opportunity Won
  → Sales Order Confirmed
  → Project/Delivery Created
```

FACT: This repository supports a direct CRM → Project path.

INFER: The direct path is acceptable if it represents a lightweight delivery-intake workflow. It should not replace the Sales Order path when commercial fulfillment, invoicing, inventory, or revenue commitments are involved.

Recommended rule:

- CRM → Project: optional delivery intake.
- CRM → Sales Order → Project: required when the sale creates commercial, inventory, billing, or formal fulfillment obligations.

---

11. Lifecycle/state-machine defects

Confirmed strengths

FACT:

- Terminal rows must satisfy the database consistency constraint:
  - Won requires `won_at`, no `lost_at`, probability 100.
  - Lost requires `lost_at`, no `won_at`, probability 0.
  - Open states cannot have terminal timestamps.
- Browser writes cannot directly modify guarded lifecycle fields.
- Terminal records cannot be moved through ordinary stage updates.
- Reopen is separately guarded.
- Lost requires a reason or note.
- Stage deactivation is guarded.
- Stage terminal flags have uniqueness controls per business.

Defects and gaps

1. Unreachable `proposition`.
2. No dedicated lifecycle timestamp for qualification was verified as part of the lead model.
3. Stage configuration is not sufficiently administrative.
4. Assignee validation is not fully branch-aware.
5. Archive is registered as an event topic, but a complete operational archive lifecycle was not verified as a first-class flow.
6. Won has no approval or prerequisite gate. This may be acceptable for small teams, but enterprise use may require:
   - Mandatory company/contact resolution.
   - Minimum value or required fields.
   - Approval above threshold.
   - Required expected close date.
7. No concurrency/optimistic-locking behavior was behaviorally proven. The RPCs are atomic, but stale-client conflict semantics need explicit tests.

---

12. Calculation/reporting defects

Current calculations

FACT:

- Pipeline value is based on expected revenue.
- Weighted value is effectively:

```text
expected_revenue × probability / 100
```

- Export derives status from terminal timestamps.
- Dashboard relies more heavily on stage flags.
- Pipeline branch filtering is applied server-side by the lead query.

Defects

1. No lead currency field.
2. No exchange-rate or base-currency conversion.
3. No authoritative reporting view or RPC.
4. Different surfaces use different state derivations.
5. Scheduled report is schema-stale.
6. Browser aggregation is exposed to row limits.
7. Null/zero probability handling is implicit UI logic, not a documented domain rule.
8. Stage probability defaults do not appear to provide a complete forecasting policy.
9. Pipeline history is not yet sufficient for period-over-period funnel analytics unless history is queried as the source.

Required reporting model

INFER: Introduce authoritative read models such as:

- `crm_pipeline_current_v`
- `crm_pipeline_by_stage_v`
- `crm_pipeline_weighted_v`
- `crm_conversion_funnel_v`
- `crm_lost_reason_analysis_v`

Or equivalent reporting RPCs that:

- Enforce business and branch scope.
- Use `status` as lifecycle authority.
- Use stage only as pipeline placement.
- Convert currency before aggregation.
- Aggregate in SQL.
- Return explicit as-of timestamps.

---

13. Audit/history defects

Confirmed strengths

FACT:

- Lead history is trigger-written.
- History includes lifecycle/stage/branch context.
- History is designed as append-only.
- There are no ordinary update/delete policies for history.
- Outbox events are emitted for major transitions.
- System activities are written for lifecycle actions.

Defects

1. History grants are excessive.
2. CRM topics have no registered consumer domains.
3. No `crm.lead.created` topic was found.
4. The live CRM tables are currently empty, so event/history behavior is structurally verified but not proven against live tenant data.
5. Field-level audit coverage is incomplete unless history payloads conclusively capture old/new values for every material change.
6. Reminder/notification outcomes are not durably represented as CRM events.

Minimum required audit trail

STD + INFER: CRM history should preserve:

- Actor.
- Timestamp.
- Organization/business/branch.
- Event type.
- Previous and next lifecycle state.
- Previous and next stage.
- Previous and next owner.
- Previous and next expected revenue/probability.
- Lost reason and notes.
- Reopen reason.
- Branch-transfer source and target.
- Conversion target document identity.
- RPC/command identity or correlation ID.

---

14. Missing but genuinely required

These are required before CRM should be considered enterprise-ready.

P0 — Correctness and isolation

1. Fix automation activity creation by deriving the parent lead’s organization, business, and branch.
2. Fix scheduled CRM report schema usage.
3. Fix AI assistant CRM context query.
4. Make `crm_lead_items.business_id` mandatory after a safe backfill.
5. Add lead/business composite foreign keys for lead items.
6. Enforce product/business compatibility.
7. Repair `crm_lead_history` grants.
8. Refresh the CRM database contract tests so they match the live catalog.

P1 — Lifecycle and permissions

9. Resolve the `proposition` state.
10. Introduce a dedicated pipeline-admin permission.
11. Make reassignment branch-aware where branch access is intended to constrain ownership.
12. Define archive behavior or remove the unused archive event.
13. Add explicit qualification and proposition timestamps if funnel analytics matter.
14. Add reopen reason capture.
15. Define and test optimistic concurrency behavior.

P1/P2 — Reporting and activity operations

16. Add currency to leads or formally declare expected revenue to be base-currency-only.
17. Add server-side reporting views/RPCs.
18. Standardize lifecycle-state derivation.
19. Add activity reminders/notifications.
20. Add durable overdue/next-activity semantics instead of deriving everything only in the browser.
21. Add duplicate lead/contact detection and merge strategy.
22. Add lead source structure sufficient for attribution reporting.

P2 — Event operations

23. Add `crm.lead.created` if acquisition automation or analytics are required.
24. Register actual event consumers or explicitly mark the topics as external-integration-only.
25. Add correlation IDs and payload versioning to emitted events.
26. Add dead-letter monitoring/operational handling for CRM events.

---

15. Unnecessary / do not build now

INFER: The following should not be started until P0/P1 repairs are complete:

- AI lead scoring.
- Predictive forecasting.
- Marketing automation.
- Campaign management.
- Web-to-lead capture.
- Advanced CPQ.
- Complex territory assignment.
- Full event-sourcing rewrite.
- Automatic invoice creation on Won.
- Automatic journal posting on Won.
- Custom-field expansion as a substitute for missing core CRM fields.
- Advanced approval workflows, unless a concrete customer requirement exists.
- Machine-learning duplicate detection before deterministic duplicate rules exist.

The immediate need is correctness, isolation, lifecycle completeness, and reporting authority—not more CRM surface area.

---

16. Recommended architecture

Command model

INFER: CRM mutations should be divided into three categories:

1. Ordinary descriptive fields

Examples:

- Name.
- Notes.
- Contact details.
- Expected close date.
- Tags/custom display metadata.

These may remain controlled CRUD operations if RLS and validation are sufficient.

2. Business commands

These must remain RPC/server-owned:

- Qualify.
- Move to proposition.
- Move stage.
- Mark Won.
- Mark Lost.
- Reopen.
- Reassign.
- Transfer branch.
- Convert to Contact.
- Convert to Estimate.
- Convert to Sales Order.
- Convert to Project.
- Archive, if retained.

3. Configuration commands

These require administrative permissions:

- Create stage.
- Rename stage.
- Reorder stage.
- Change probability default.
- Mark stage Won/Lost.
- Deactivate stage.
- Manage lost reasons.

Data-integrity model

Required database guarantees:

- `crm_lead_items.business_id NOT NULL`.
- `(lead_id, business_id)` composite FK.
- Product/business validation.
- Lead/business/branch consistency.
- Mandatory terminal-state consistency.
- History least-privilege grants.
- Administrative stage policies.
- Reporting views/RPCs that enforce the same tenant predicates as base tables.

Event model

Recommended target:

```text
CRM command RPC
  → atomic state mutation
  → history row
  → outbox event
  → dispatcher
  → registered consumer
  → durable result / dead-letter handling
```

The current implementation has the first four layers, but the consumer and operations layers are not yet proven.

---

17. Phased execution plan

Phase R0 — Repair the false completion claims

Objective: Make the existing CRM safe and internally consistent before adding features.

1. Fix `process-automation` CRM activity creation.
2. Fix scheduled CRM pipeline report.
3. Fix AI assistant CRM context query.
4. Repair `crm_lead_items`:
   - Backfill business.
   - Make business mandatory.
   - Add composite lead/business FK.
   - Add product/business validation.
5. Revoke excessive history grants.
6. Refresh stale SQL contract tests.
7. Add regression tests for every repaired consumer.

Gate: All CRM tests, edge-function contract tests, and catalog checks pass.

---

Phase R1 — Complete the lifecycle

1. Add or remove `proposition`.
2. Define archive behavior or remove the unused event.
3. Add lifecycle timestamps required for funnel analytics.
4. Add reopen reason capture.
5. Introduce pipeline-admin permission for stage configuration.
6. Make assignment branch-aware if required by the access model.
7. Verify optimistic concurrency semantics.

---

Phase R2 — Reporting and activity foundation

1. Add authoritative reporting views/RPCs.
2. Standardize on `status` for lifecycle filtering.
3. Resolve currency handling.
4. Add SQL-side aggregation.
5. Add durable activity reminder/notification behavior.
6. Define overdue and next-activity semantics server-side.
7. Add duplicate detection and merge rules.

---

Phase R3 — Conversion and event consumers

1. Harden Contact/Estimate/Sales Order/Project conversion prerequisites.
2. Ensure conversion RPCs consume validated lead items.
3. Add source-lineage reporting.
4. Add real consumers for CRM events where required.
5. Add dead-letter monitoring.
6. Document which events are internal versus external integration contracts.

---

Phase R4 — Feature expansion

Only after R0–R3:

- Assignment automation.
- Funnel analytics.
- SLA/follow-up escalation.
- Approval thresholds.
- Advanced forecasting.
- Source attribution.
- Optional web-to-lead or campaign intake.

---

18. Validation / invariant tests

Database contract tests

Required tests include:

1. Every allowed lifecycle transition succeeds.
2. Every forbidden lifecycle transition fails.
3. Direct lifecycle-field update fails.
4. Won terminal consistency is enforced.
5. Lost terminal consistency is enforced.
6. Lost without reason or note fails.
7. Reopen from non-terminal fails.
8. Reopen to an invalid state fails.
9. Stage/business mismatch fails.
10. Activity/lead business mismatch fails.
11. Lead-item/lead business mismatch fails.
12. Product/business mismatch fails.
13. History cannot be updated or deleted through ordinary roles.
14. History grants are least-privilege.
15. Only pipeline administrators can mutate stage semantics.
16. Terminal stage uniqueness remains enforced.
17. Conversion RPCs are idempotent.
18. Branch transfer rejects unauthorized branches.
19. Assignee must satisfy the intended business/branch access rule.
20. Outbox payload contains organization, business, branch, actor, and correlation identity.

Consumer regression tests

Add executable tests for:

- Automation-created activity includes valid organization/business/branch.
- Scheduled CRM report uses the current lead/company-contact schema.
- AI assistant uses `stage_id`/`crm_stages`, not removed columns.
- Contact profile remains correctly scoped.
- Project source-lead display remains correctly scoped.
- Pipeline export and dashboard use the same lifecycle authority.

Data validation tests

Before migration deployment:

- Find lead items with null business.
- Find lead items whose business differs from the parent lead.
- Find products that do not belong to the lead’s business.
- Find histories with missing business/branch context.
- Find duplicate terminal stages.
- Find leads with contradictory status/timestamps.

---

19. Execution status

Prior phase verification

| Prior claim | Verified status | Reason |
|---|---|---|
| Phase 0 — test harness | INCOMPLETE | Tests exist and targeted Vitest guards passed, but the SQL contract contains stale catalog assumptions and does not cover broken edge-function consumers. |
| Phase 1 — tenancy repair | INCOMPLETE | Leads/stages/activities improved, but `crm_lead_items` remains nullable and lacks the required composite integrity. |
| Phase 1 — authorized RPC entry points | MOSTLY CONFIRMED | Core lifecycle RPCs check access; assignment lacks complete branch validation. |
| Phase 2 — lifecycle enum and guards | MOSTLY CONFIRMED | Guards and terminal invariants are live; `proposition` is unreachable. |
| Phase 2 — client hooks no longer directly mutate lifecycle | CONFIRMED | Architecture tests and hook inspection support this. |
| Phase 3 — history and events | INCOMPLETE | History/outbox infrastructure exists, but grants are excessive and topics have no registered consumers. |
| Phase 4 — branch ownership | INCOMPLETE | Leads/activities/stages improved; lead items and branch-aware assignment remain unresolved. |
| Downstream conversion | MOSTLY CONFIRMED | Contact/Estimate/Sales Order/Project conversion architecture exists. |
| Downstream consumers updated | FALSE | Automation, scheduled reporting, and AI assistant contain confirmed stale or invalid CRM access paths. |
| “Phase 5 is next” | FALSE | The next phase must be P0 repair of the incomplete Phase 0–4 claims. |

Final execution state

- Audit complete.
- No code changed.
- No migration submitted.
- No database data changed.
- Recommended next milestone: Phase R0 — Repair false completion claims and downstream consumers.

No code or database changes were made.