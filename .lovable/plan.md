# Cycle Count Governance Wave — status

## Done

- **Phases 1–6** (previous owner) re-verified this pass and confirmed: Warehouse
  registered as a governed module, `physical_count_submit` routes
  `warehouse.count_variance` through `approval_route`, decisions mirror back,
  manual approve refuses while a request is live, paperwork versions itself,
  sign-offs come only from `get_count_signoffs`.
- **Phase 8 — Warehouse is now visible and configurable in governance settings.**
  - `Settings → Governance → Advanced (per-action overrides)` now builds its
    table from `governance_action_registry` (the DB truth) instead of the
    hardcoded catalogue, so every registered action — Warehouse, and the
    previously invisible Purchasing reversal/landed-cost keys — can be
    configured. The static catalogue is merged in for entity metadata only.
  - `warehouse.count_variance` added to `SELF_ACTION_CATALOGUE` with a new
    `physical_count` entity type, plus a picker source so a one-time override
    can be issued against a specific count.
  - Guards: registry-driven rendering is now pinned by
    `governance-action-registry-parity.test.ts`; `sod-coverage.test.ts` gained an
    `ENGINE_ROUTED_ACTIONS` class asserting the action goes through
    `approval_route` rather than a SoD trigger.
- **Phase 10 — gated-mode proof** added to
  `supabase/tests/cycle_count_governance_test.sql` (tests 16–19): the action is
  registered and active, STANDARD routing resolves only through
  `_approval_match_rule` and `physical_count_submit` contains no mode branch,
  active rules must name a reachable approver, and STRICT self-approval refusal
  plus ADVANCED single-use overrides are consulted by `approval_decide` /
  `governance_assert_not_self`. All four verified green against the live
  database.

## Remaining — Phase 9, live SOLO acceptance run

Blocked on an authenticated session: count RPCs raise `access denied` without
one, and this project uses an external unmanaged Supabase, so no sandbox session
can be minted. A signed-in operator must, in the preview:

1. Run a fresh count with a difference outside tolerance and submit it.
2. Confirm SOLO auto-approves and posts in the same step (no "a supervisor must
   approve" copy), with `submitted_by` / `approved_by` / `posted_by` stamped.
3. Confirm the stock delta applied exactly once, and replay the approval to
   prove idempotency.
4. Reprint the Difference Report for evidence session `PC-000005`
   (`551d3439-7600-4e51-bc04-88b4444bb807`) — its v1 must become
   `superseded` pointing at a v2 whose snapshot carries all three actors.

## Constraints that still hold

One approval engine only. Stock moves only through the Inventory adjustment
path. `get_count_lines` stays the sole line read path. Sign-offs come only from
`get_count_signoffs`, never from the logged-in user.
