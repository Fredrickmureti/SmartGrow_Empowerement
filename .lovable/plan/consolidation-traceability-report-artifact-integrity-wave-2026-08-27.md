# Consolidation Traceability & Report-Artifact Integrity Wave

The remaining consolidation roadmap is paused. This wave establishes one traceability model for consolidation reporting, then applies it category by category.

Note on the Supabase request: this project is already connected to an external Supabase project (ref `jkszmrroyjfdwokbkzis`). A project can only be bound to one backend, so no new connection is made here. If `AccrualFlowCorporation` is a different Supabase project, say so and we'll handle the rebinding separately.

## What the investigation already established (verified, not assumed)

Finance already has a canonical traceability architecture, and consolidation only partially joins it.

Verified platform pattern (single-company finance reports):
- Reporting scope lives in URL query params, owned by `useReportWorkspaceState` (`REPORT_SCOPE_KEYS`: period/from/to/branch/contact/basis/...).
- `resolveLedgerDrillTarget()` is the single rule mapping a ledger row's `source_type` / `source_id` / `journal_entry_id` to a drill target; falls back to journal entry, then to "no preview".
- `TransactionPreviewDrawer` (and `DrillDownDialog` for figure→account→ledger) renders the target and offers "View Full Record" to the source document page; journal entries have a real route `/finance/journal-entries/:id`.
- Server artifacts go through `ReportExportService` → `render-report` edge function → `reportDataEngine`, which calls the same RPCs as the screens (verified for `get_general_ledger`), with shared accounting primitives in `accountingKernel.ts`.

Verified consolidation state (5 surfaces, all under `/finance/reports/*`):
- Cross-Company Comparative, Consolidated TB, Consolidated Statements, Intercompany, Eliminations.
- All read from Postgres RPCs; none recompute in the browser. Exports are built from the same on-screen row model. Cross-Company has no export at all.
- The only drill-down that exists is Consolidated Statements → Eliminations (carries group, date range, group account).
- No surface reaches entity account → GL movements → journal entry → source document.
- Permission gate is `useFinancePermission("finance.view_consolidated")` evaluated against the user's *currently active single business*, not against each group member — and its own docstring says it is a UX rail only.
- Database lineage largely already exists: `consolidation_elimination_evidence(...)` returns `journal_entry_id`, `entry_number`, `entry_date` and a `viewer_can_open_ledger` flag; `consolidation_intercompany_entry_lines(...)` exposes journal-entry-level rows. `consolidation_eliminations.source_evidence` holds `source_account_ids` and `entry_count` but no journal entry ids.

Correction to earlier assumptions: eliminations are not an opaque adjustment at the data layer — the evidence RPC exists and is unused by the UI. The primary gap is UI/route wiring and permission scoping, not a missing accounting engine.

## Approach

One category at a time: investigate → confirm behaviour → implement → test UI, artifact and permissions → close. No parallel edits across surfaces. No new accounting engine, no browser-side recalculation, no new FX/CTA/elimination logic.

### Category 1 — Traceability contract and shared plumbing
Write the contract (below) into a short ADR, and add a consolidation-specific drill resolver that reuses `resolveLedgerDrillTarget` and the existing scope param keys, plus a `ConsolidationLineageDrawer` built on `TransactionPreviewDrawer`. Deep links must carry business, account, period and group using existing param names — no new URL convention.

### Category 2 — Eliminations lineage (highest value, data already present)
Wire `consolidation_elimination_evidence` into the Eliminations report: expand an elimination row to its contributing journal entries per entity, honour `viewer_can_open_ledger` for the link, and deep-link into General Ledger / journal entry detail. Verify the evidence rows sum to the elimination amount.

### Category 3 — Intercompany
Drill from an intercompany balance/flow row to `consolidation_intercompany_entry_lines` detail (both sides of the relationship), then to journal entries and source documents through the shared resolver.

### Category 4 — Consolidated Trial Balance
Add group account → contributing entity → entity account → GL drill, using the existing translated-TB RPC output plus a per-entity detail query. Non-drillable levels (FX translation effect, CTA, elimination-derived amounts) are labelled as adjustments and routed to their explaining surface rather than given a fake ledger link.

### Category 5 — Consolidated Statements
Extend the existing eliminations hop: each statement figure drills to entity contributions, then to mapped account and GL. Keep the current eliminations link intact.

### Category 6 — Cross-Company Comparative
Confirm what each figure is (`get_account_movements` per allowed business), add account/entity drill into General Ledger preserving business and period, and add the missing server-side export so it matches the other surfaces.

### Category 7 — Permissions and isolation
Replace the active-business-only permission check with a per-target-business check at drill time, and confirm server-side enforcement: every drill RPC must independently reject businesses the caller cannot access. Tested with a user who can access one member but not another.

### Category 8 — Server artifacts
For each consolidation report, confirm the export path uses the same authoritative rows as the UI, and add required artifact-level context to headers: group, entities included, period, presentation currency, basis, and generation metadata. PDFs get context, not fake links; Excel gets canonical deep links only where the platform already does that elsewhere.

## Traceability contract (to be validated during Category 1)

- Every material consolidated figure resolves to an authoritative source accounting object, or is explicitly labelled an adjustment with its own explaining surface.
- Every elimination identifies its class, both entities, its rule, and its contributing journal entries.
- Drill-down authorisation is evaluated per target business server-side; UI gating is never the boundary.
- Deep links use existing platform route and scope-param conventions.
- Artifacts derive from the same RPCs as the UI; no browser recalculation of accounting values.
- Future consolidation bricks ship lineage with the feature, not after it.

## Deliverable

A structured checkpoint covering verified current state, corrected assumptions, the traceability map per surface, genuine drill/deep-link/artifact/security gaps with evidence, changes made, tests run, the final contract, and an evidence-based readiness answer.

## Technical notes

- New shared code: consolidation drill resolver + lineage drawer, layered on `resolveLedgerDrillTarget`, `TransactionPreviewDrawer`, `useReportWorkspaceState`.
- Likely migrations: expose journal-entry-level evidence for the remaining surfaces where an equivalent of `consolidation_elimination_evidence` does not yet exist, and add `viewer_can_open_ledger`-style authorisation to those functions. Schema changes are additive; existing RPCs are not rewritten.
- `consolidation_eliminations.source_evidence` may gain journal entry ids so stored eliminations are self-explaining without recomputation.
- Tests: reconciliation assertions (drill totals equal parent figure), permission-isolation tests per drill RPC, and artifact-vs-UI parity checks.
