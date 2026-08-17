# Cycle Count Governance Wave — verification verdict and remaining work (2026-08-17, new owner)

Goal (unchanged): the cycle-count variance decision is made by the ONE canonical
approval engine, SOLO tenants are never told a manager must approve, and count
paperwork prints the real COUNTED BY / REVIEWED BY / APPROVED BY actors.

## Phase 1 — independent verification of the previous engineer's claims

Every claim re-checked against the live database and the source tree this pass.

| Claim | Verdict | Evidence |
|---|---|---|
| Warehouse registered as a governed module | Confirmed | `governance_action_registry` holds `warehouse.count_variance`, module `Warehouse` (1 row) |
| `physical_count_submit` routes through `approval_route` | Confirmed | Function body calls `approval_route('warehouse.count_variance', …)` with variance lines/units/value payload, idempotency key `warehouse.count_variance:<id>`, and a fail-safe that parks the count in review and audits the reason instead of losing it |
| Decision mirrored back onto the count | Confirmed | `trg_mirror_approval_to_physical_count` exists |
| Manual approve refuses while a request is live | Confirmed | `physical_count_approve` raises `GOV_USE_APPROVAL_ENGINE` |
| No orphan "awaiting approval" | Confirmed | 0 lines on approved/posted counts still read `pending` |
| Paperwork built by one snapshot pipeline, actors only from `get_count_signoffs` | Confirmed | Legacy fetchers gone; `ensure_document_record` contains the supersede branch |
| Governance-aware copy (`wms_count_governance_preview`) | Confirmed | RPC present and correct: resolves mode, matches `_approval_match_rule`, returns `gated` |
| Regression tests green | Confirmed | 14/14 passing across the three governance/pipeline/parity suites |
| Phase 7 live acceptance run | **Not done** | Evidence session `551d3439…` still carries a single `wms.count_variance_report` **v1**, `awaiting_approval: 1`, `signoffs: null`, `status = issued`, nothing superseded |

So Phases 1–6 hold up structurally. The wave is **not** finished, and two gaps
the previous engineer never recorded are confirmed defects.

## Confirmed open defects (added this pass)

### Defect A — the engine path has never executed once
`approval_requests` contains **zero** rows for `warehouse.count_variance`, and
zero `physical_counts` carry an `approval_request_id`. Both posted counts in the
database pre-date the wiring and went down the legacy SoD path. The routing code
is therefore unproven against real traffic: every assertion so far is structural,
not behavioural.

### Defect B — Warehouse is still invisible in Advanced → per-action overrides
This is exactly the symptom reported. `SelfActionPolicy.tsx` ("Advanced —
per-action overrides") groups rows from the **hardcoded** `SELF_ACTION_CATALOGUE`
in `src/lib/governance/selfActionCatalogue.ts`, whose `module` union is
`Payroll | HR | Finance | Purchasing | Sales | Inventory | Spend` — no
Warehouse member exists in the type at all. The DB registry is the real source of
truth and already carries the Warehouse row, but the screen never reads it. The
parity test only checks catalogue → migration, so registry rows with no catalogue
entry drift silently and invisibly.

### Defect C — no policy surface for the routed action
`approval_rules` has **zero** rows for `warehouse.count_variance` and
`self_action_policy` zero rows for any `warehouse.*` key. In SOLO that is the
correct outcome (no rule matched → `NULL` route → approve and post in the same
transaction), but a STANDARD/STRICT tenant currently has no configured path
either, and no screen through which to configure one. Defect B is what blocks it.

## Remaining phases

### Phase 8 — make the governance registry the single source for the override UI
Replace the hardcoded grouping in `SelfActionPolicy.tsx` with
`useGovernanceActionRegistry()`, keeping the static catalogue only as the
compile-time mirror used by triggers. Add `Warehouse` to the catalogue module
union and add a `warehouse.count_variance` entry (label, description, subject
table `physical_counts`, severity) so both sides agree. Then tighten
`governance-action-registry-parity.test.ts` to assert parity in **both**
directions, so a future registry row that no screen exposes fails the build.
Result: Warehouse appears in Advanced → per-action overrides, alongside the
existing Inventory count keys, and a tenant can set STANDARD/STRICT policy for it.

### Phase 9 — SOLO end-to-end acceptance run (was Phase 7)
Execute the real business event with a signed-in operator and record before/after
evidence in this file:
1. Fresh count with a material variance above tolerance.
2. `physical_counts` state plus `submitted_by` / `approved_by` / `posted_by`.
3. Route outcome: `NULL` under SOLO, with the `sod.self_action_auto_allowed`
   audit row — or the `approval_requests` + `approval_history` pair when gated.
4. `stock_quants` delta applied **exactly once**; journal consequence where
   applicable.
5. `business_event_outbox` topics and `audit_logs`.
6. Difference Report regenerated with all three actors populated.
7. Replay the approval to prove idempotency — no second adjustment.
8. Re-render the evidence session `551d3439-7600-4e51-bc04-88b4444bb807`
   (`PC-000005`): its v1 must flip to `status = superseded` with `superseded_by`
   pointing at a v2 whose snapshot carries the sign-offs.

### Phase 10 — gated-mode proof
With a `warehouse.count_variance` rule configured through the new screen, prove
STANDARD routes and waits, STRICT refuses self-approval, and an ADVANCED
per-action override is respected — extending
`supabase/tests/cycle_count_governance_test.sql` and the architecture suite
rather than adding new files.

## Constraints that still hold
One approval engine only — no new tables, no parallel approval path, no
`if solo` branch anywhere in Warehouse. Stock moves only through the Inventory
adjustment path. `get_count_lines` stays the sole line read path. Sign-offs come
only from `get_count_signoffs`, never from the logged-in user.

## Note on Phase 9 execution
Count RPCs raise `access denied` without an authenticated session, and this
project uses an external unmanaged Supabase, so no sandbox session can be minted.
Phase 9 runs in the preview by a signed-in operator; Phases 8 and 10 do not
depend on it and are done first.
