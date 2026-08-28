# Consolidation — status after R6 (translation reserve)

## Done

- **R2b — artifact identity.** Verified in place: the renderer's short hash is
  labelled `Export ref` in `BrandedFooter`, never "Run"; no artifact can label a
  render hash as a consolidation run. Covered by
  `consolidation-artifact-identity.test.ts` (6 assertions, green).
- **R4 / R5** — as previously recorded.
- **R6 — the reserve articulates and belongs to the group.**
  - Roll-forward: `consolidation_translate_member` emits the residual with
    opening, movement and closing (opening + movement = closing), and
    `consolidation_cta_reconciliation` proves it per translated member.
  - Ownership: new `consolidation_groups.cta_group_account_id` points at a
    group-chart equity account. `_consolidation_cta_account_guard` validates it
    (same group, equity, active). `get_consolidated_trial_balance_translated`
    presents the residual on that group account, and refuses outright when a
    group that keeps its own chart has a translating member but no group
    reserve line — the reserve may no longer be shown on a member's equity
    account. `Joshua Holdings Group` seeded with `G3950 Foreign currency
    translation reserve`.
  - Surface: the Currency translation card in Consolidation settings now
    configures the group reserve line alongside the carrier account.
  - Guard: new assertion in `consolidated-trial-balance.test.ts`.

## Remaining

**R7 — close Brick 8 for real.** Revoke `anon` EXECUTE on
`consolidation_create_run`, `consolidation_finalize_run`,
`consolidation_supersede_run` and the sibling consolidation RPCs, then drive one
genuine create → finalize → supersede run against this group and prove the
finalized figures survive a later member rate edit unchanged.

**Final artifact acceptance gate.** Every consolidation surface (Cross-Company
Comparative, Consolidated TB, Consolidated Statements, Intercompany,
Eliminations) across screen / PDF / Excel: data source, screen-to-artifact
parity, totals reconciliation, identity, traceability, run-label truthfulness,
typography, and access isolation for a user entitled to only some members.
Evidence recorded per artifact, from regenerated files inspected page by page.

## Deliberately not in scope

No NCI, no equity method, no consolidated cash flow — Brick 9 starts only after
the gate passes.
