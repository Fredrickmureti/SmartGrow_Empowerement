# Cash & Banking Reporting — Authoritative Status (2026-08-20, late session)

Legend: **[DONE]** implemented and verified · **[PENDING]** not started · **[ACTIVE]** in progress
History: `.lovable/plan/cash-banking-reporting-*.md`, `.lovable/plan/finance-wave-*-banking-*.md`.

## Where the roadmap stands

| Phase | Subject | Status |
| --- | --- | --- |
| 0–6 | Engine, isolation, currency, exports, Banking page de-arithmetic | **[DONE]** (verified earlier this session) |
| 7 | Cash position as of a date | **[DONE]** |
| 8 | Unreconcile | **[DONE]** (already existed; verified) |
| 9 | Session-context-aware reconciliation | **[DONE]** |
| 10 | Residual explainer | **[DONE]** — this session |
| 11 | Rule engine scrutiny | **[PENDING]** — next |
| 12 | Feed → statement → match → GL chain proof | **[PENDING]** |
| 13 | Scheduled/branch dimension (needs migration) | **[PENDING, deferred]** |

## Completed this session

### Phase 7 — Cash position as of a date
- `src/hooks/useBankAccounts.ts` threads an optional `asOf` through `loadBankAccounts`,
  `getBankAccounts` and `useBankAccounts`, into `bank_account_positions`. The as-of date is part
  of the cache key, so two dates can never share a cached result.
- `src/pages/Banking.tsx` has an "As at" picker (capped at today) and states the date on the
  Total Balance card, so the dashboard and the reconciliation statement cannot drift by date.
- `supabase/tests/bank_account_positions_invariants_test.sql` guards the RPC: still
  SECURITY INVOKER, not executable by `anon`, RLS-scoped, signed-amount statement balance,
  `_as_of` honoured.

### Phase 8 — Unreconcile (verified, no change needed)
`unreconcile_bank_transaction` (which delegates to `bank_match_reverse`) is wired through
`useBankTransactions.unreconcileTransaction` and exposed as "Unreconcile" in
`src/pages/BankReconciliation.tsx`. No client-side writes to `bank_transactions.reconciled`
or `bank_reconciliation_matches`.

### Phase 9 — Session-context-aware reconciliation
`src/pages/BankReconciliation.tsx` reads `?session=`, selects that session's bank account,
switches to the right tab (in-progress → transactions, closed → recon history) and shows a
session banner with a "Clear" action. "Open" from the sessions register is no longer
context-blind.

### Phase 10 — Residual explainer (this session)
- **Engine.** `finance_bank_reconciliation_statement` now returns
  `residual_explanations`: a ranked array of candidate causes, produced server-side and only
  when the residual is material (≥ 0.01) and the book side is computable. Codes:
  `duplicate_opening_balance` (rank 10), `unmatched_equal_pairs` (20), `sign_flipped_pairs` (30),
  `cleared_without_posting` (40), `single_item_equals_residual` (50), `fx_fallback_lines` (60).
  Each carries a title, an instruction, the exact amount and up to 20 offending rows
  (journal entry or statement line). Function stays SECURITY DEFINER, `search_path=public`,
  `finance_can_read_org` gated, no `anon` EXECUTE. Nothing is mutated.
- **Client seam.** `src/services/finance/bankReconciliationStatement.ts` exposes
  `ResidualExplanation` / `ResidualExplanationRef` and maps the payload verbatim.
- **UI.** `src/components/reports/ResidualExplainer.tsx` replaces the bare
  "Statement does not reconcile" banner in `src/pages/reports/BankReconciliationReport.tsx`
  with ranked, expandable suggestions listing the offending rows. Presentation only: no
  filtering, sorting, arithmetic or data access in the component.
- **Tests.** `supabase/tests/bank_reconciliation_residual_explainer_test.sql` proves the array is
  always present, empty when reconciled, well formed, restricted to the closed code vocabulary,
  and that asking for explanations does not change the proof.
  `src/test/architecture/bank-reconciliation-single-engine.test.ts` gained a guard that the page
  renders `residualExplanations` and that the explainer invents no causes of its own (6/6 pass).

## Known gaps carried forward

- **Not run in CI:** the two new SQL invariant files need a `service_role` session; the read-only
  query tool has no EXECUTE on the engine, so they were reviewed, not executed here.
- **Live data:** "Joshua Holdings" / "Test Operating Bank – KES" still carries the −50,000.00 KES
  opening-balance duplicate. The explainer should now name it as
  `duplicate_opening_balance`; **this has not yet been confirmed against live data** and is the
  first thing the next agent should check. The underlying duplicate must still be reversed in data.
- **Export parity:** explanations are screen-only. The PDF/server path
  (`supabase/functions/_shared/reportDataEngine.ts`) still renders the residual without causes.
  Decide in Phase 11/12 whether the delivered document should carry them.
- ~111 pre-existing failing test files elsewhere in the repo are unrelated; do not fix them here.

## Phase 11 (RE-SCOPED, NOW THE ACTIVE PRIORITY) — Actionable reconciliation workspace

**Ultra-focus here. Do not open unrelated domains. No shallow patching, no guessing.**

The report already *names* what is drifting; it does not let the accountant *do anything about
it*. Worse, the one remedial action we do expose fails hard:

```
POST /rest/v1/rpc/unreconcile_bank_transaction 400
P0001: Cannot modify a posted journal entry. Create a reversing entry or void it instead.
```

Observed on the −50,000.00 KES opening-balance duplicate ("Joshua Holdings" / "Test Operating
Bank – KES"). The reconciliation seam collides with the posting monopoly
(`void_journal_entry_atomic` is the only legal reversal writer — see
`mem://features/business-reversal-architecture`). Unreconciling a match whose journal entry is
posted is currently a dead end presented to the user as a raw Postgres error.

### 11.0 — Research first, decide second (mandatory, no guessing)

Before writing any code, research how mature systems handle *un-matching a reconciled bank line
whose journal entry is already posted*, and write the findings into
`docs/architecture/decisions/` as an ADR with sources:

- Microsoft Dynamics 365 Business Central / F&O — bank account reconciliation, "Remove match",
  reversal of posted bank ledger entries, `Reverse Transaction` / correcting entries.
- Oracle Fusion Cloud Cash Management — unreconcile / reverse reconciliation, and how it handles
  period-closed vs open periods.
- NetSuite — "Undo reconciliation" and reversing journal behaviour.
- SAP S/4HANA — FEBAN/FEBA reset of cleared items, `FBRA` reset clearing + reversal.
- QuickBooks / Xero — "Undo reconciliation", "Remove & redo", cancel/void bank transactions.

The ADR must answer explicitly: do these systems (a) refuse and force a reversing entry, (b)
allow un-match while keeping the GL untouched, or (c) auto-generate the reversal as part of the
un-match — and what changes when the period is closed. Our behaviour follows the majority
enterprise pattern, not our convenience.

### 11.1 — Un-match must not be a dead end

Whatever the ADR concludes, the accountant must never see a raw `P0001`. Expected shape (confirm
against the research):

- Separate *un-match* (break the link between bank line and document) from *reverse the posting*
  (a GL event). If the industry norm is that un-matching does not itself touch the GL, then
  `unreconcile_bank_transaction` should succeed for the link and surface the posted entry as a
  distinct, explicitly-authorised follow-up.
- Where reversal genuinely is required, route it through `resolve_reversal_intent` +
  `preview_reversal_consequences` + `void_journal_entry_atomic`. Never a new bypass writer.
- Pre-flight the action: the UI asks the policy what is legal *before* enabling the button, so
  the failure is explained in advance, not thrown after the click.

### 11.2 — Every diagnosis carries its remedy, in-workspace

Each `residual_explanation` code must map to a declared remedy: label, permission, target route
or in-place action, and precondition. Rendered as a quick-action button next to the finding:

| Code | Remedy |
| --- | --- |
| `duplicate_opening_balance` | Open the duplicate journal entry / launch the guarded void-with-preview flow |
| `unmatched_equal_pairs` | Jump to the reconciliation sheet with both sides preselected |
| `sign_flipped_pairs` | Open the offending line for correction |
| `cleared_without_posting` | Post the missing entry via the owning document |
| `single_item_equals_residual` | Open that line in the match sheet |
| `fx_fallback_lines` | Open FX rate settings for the affected dates |

Rules: the remedy map is data, declared once (server-side alongside the explanation, or one
client table adjacent to `ResidualExplainer`) — not `if/else` scattered through components. A
button is disabled with a stated reason when the user lacks the permission or the precondition
fails. Deep links carry full context (account, session, date range, entry id) so the accountant
lands on the exact row, never on a bare list.

Prefer resolving in-place inside the reconciliation workspace via a side panel (preview →
confirm → return to the residual, refreshed) over navigating away; navigate out only when the
remedy legitimately belongs to another module, and then return the user with a back-link.

### 11.3 — Errors become guidance

No RPC error reaches a toast verbatim. Map every known reconciliation error code to an
explanation plus the next legal action. Unknown codes get a generic message plus a support
reference — and a test that asserts raw Postgres text never renders.

### 11.4 — Proof

- SQL invariant tests: un-match legality matrix (posted / unposted / period-closed /
  bank-reconciled), idempotency of re-running an un-match, and that no path mutates a posted
  journal entry outside `void_journal_entry_atomic`.
- Architecture guard: every explanation code has a remedy entry; the explainer performs no
  arithmetic and no direct `supabase` access.
- Browser verification on the live −50,000.00 KES duplicate: the finding appears, its quick
  action is offered, the action completes (or is refused with a stated, human reason), and the
  residual reflects the outcome afterwards.

### Then, and only then — original Phase 11 (rule engine scrutiny)

Audit `bank_reconciliation_rules` and `apply_reconciliation_rules`: matching precedence,
overlapping rules, amount tolerance, date window, that a rule may only *propose* and never
auto-confirm, idempotency on re-run, and a per-rule audit trail with match counts. One SQL
invariant test per behaviour, not one omnibus test.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase 10 to enterprise standard:
   run `finance_bank_reconciliation_statement` as `service_role` for the Joshua Holdings
   KES account and check that `residual_explanations` names the duplicate opening balance with
   amount −50,000.00 and the two offending references; execute
   `supabase/tests/bank_reconciliation_residual_explainer_test.sql` and
   `supabase/tests/bank_account_positions_invariants_test.sql`; open
   `/reports/bank-reconciliation` and confirm the suggestions render, expand and drill down.
   Also re-check Phases 7 and 9 in the browser (as-of date changes the figures; `?session=`
   pins the account and tab). Fix any failure before moving on.
2. **Then execute Phase 11 in order: 11.0 → 11.4.** Research before design; ADR before code.
   Reproduce the `unreconcile_bank_transaction` 400 first so the fix is evidence-led.
3. **Do not** jump to Phase 12 or 13, and do not open unrelated domains. Bring the workspace to
   a coherent, production-ready state — diagnosis *and* remedy — before progressing.


### Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.
