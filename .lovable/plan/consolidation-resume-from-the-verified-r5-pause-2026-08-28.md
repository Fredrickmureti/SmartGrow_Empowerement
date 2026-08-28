# Consolidation — resume from the verified R5 pause

## What I re-verified this session (live database, not notes)

- Group: **Joshua Holdings Group**, parent *Joshua Holdings* (KES), member
  *Mombasa Port Services* (USD). One organisation, two legal entities.
- The R5 groundwork the previous engineer claimed **does exist**:
  `fx_open_monetary_positions(business_id, as_of)` and
  `fx_unrecognised_exchange_difference(business_id, as_of)` are both present,
  SECURITY DEFINER, and revoked from `anon` (calling them unauthenticated is
  refused — confirmed).
- The blocker described in the log is real and precisely measurable. Joshua
  Holdings' only open foreign-currency monetary position at 2026-08-31 is
  account **1180 Intercompany receivable — Mombasa Port Services**:
  USD 20,000 carried at KES 2,630,000 (rate 131.5) against a closing rate of
  **129.5** → **KES 40,000 unrecognised exchange loss**. That is exactly the
  residual the consolidation engine is currently refusing on.
- Cause of the blocker: `resolve_fx_unrealized_account` finds no
  `fx_unrealized_gain` / `fx_unrealized_loss` mapping for the parent — only the
  two *realized* keys are mapped. Without it, `revalue_fx_balances` cannot post.
  (It would otherwise silently fall through a name heuristic onto the *realized*
  accounts, which would misstate realised vs unrealised FX — so mapping must be
  explicit, not left to the fallback.)
- Aug 2026 (2026-08-01 → 2026-08-31) is **open** for the parent, and no posted
  FX revaluation run exists for it, so the revaluation can post cleanly.

## Step 1 — Finish R5 (the only step that needs your approval to touch data)

1. Add two accounts to the parent's chart of accounts, with the correct detail
   types so they classify properly in the P&L:
   - `4945 FX Unrealized Gain` (income / other_misc_income)
   - `6925 FX Unrealized Loss` (expense / exchange_gain_loss)
   Both carry an IAS 21.28 description and the matching `system_role`.
2. Map them in the parent's Default Accounts as `fx_unrealized_gain` /
   `fx_unrealized_loss`, so the resolver stops guessing.
3. Run the parent's period-end FX revaluation for 2026-08-31 through the
   existing authoritative `revalue_fx_balances` — no consolidation-only
   revaluation path. Expected posting: **Dr FX Unrealized Loss 40,000 /
   Cr Intercompany receivable 40,000**, taking the receivable to KES 2,590,000.
4. Regenerate the group's eliminations and confirm the KES 40,000 residual is
   gone, then clear the fitted 41,500 tolerance plug that was fitted around it.
5. Surface the diagnosis in the consolidation UI: before the user hits a
   refusal, show which member has unrecognised exchange difference, how much,
   carried vs closing rate, and a deep link to that company's period-end FX
   revaluation — then return them to the consolidation run.
6. Tests: the refusal remedy text, and the invariant that unrecognised member
   FX can never reach the group translation reserve. Log R5 in the brick log.

## Then, unchanged in order

- **R2b** — artifacts stop printing a per-render hash under the word "Run";
  print a real run id + version, or `Export reference`.
- **R4** — `difference_policy` honoured inside tolerance too; trading-class
  residuals banned from the translation reserve; surviving residuals disclosed
  as a named reconciling line; tolerances bounded with changed-by/reason.
- **R6** — opening + movement = closing for the translation reserve, and move
  the group reserve off the parent's account 3050 onto a group-chart account.
- **R7** — revoke `anon` EXECUTE on the run-lifecycle RPCs, then drive one real
  create → finalize → supersede and prove finalized figures survive a later
  member rate edit.
- **Final artifact acceptance gate** — full inventory across Cross-Company
  Comparative, Consolidated TB, Consolidated Statements, Intercompany and
  Eliminations, screen / PDF / Excel, with actual generated files inspected.

## Technical notes

- Accounting is posted only through the existing FX revaluation engine; the
  consolidation engine gains no posting ability.
- The two new accounts are tenant chart-of-accounts data for this group, added
  alongside the existing 4940/6920 realized pair rather than replacing them.
- No NCI, equity method or consolidated cash flow, and no scaffolding for them.
