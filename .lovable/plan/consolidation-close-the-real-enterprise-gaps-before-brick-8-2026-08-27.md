# Consolidation — close the real enterprise gaps before Brick 8

## Verification of the previous engineer's claims (done this session, against the live `AccrualFlowCorporation` database and the repo)

Confirmed true:

- The engine exists and is server-side: `consolidation_generate_eliminations`,
  `consolidation_diagnose_eliminations`, `consolidation_intercompany_flows`,
  `get_consolidated_statement_lines_eliminated` / `_totals_eliminated`,
  `consolidation_cta_reconciliation`, all SECURITY INVOKER, all behind an
  owner/admin/super-admin org-role check.
- The surface exists: `ConsolidationEliminations`, three-column
  `ConsolidatedStatements`, `ConsolidationEliminationRules` in settings,
  `EliminationRefusalPanel` with server-produced remedy codes, registered in
  the finance routes, report registry, reports nav, app registry and sidebar.
- 147 account mappings, 7 group accounts, 1 group with 2 members exist, and
  eliminations were actually generated for 2026-08 by a real user id.

Confirmed **false or incomplete**:

1. **Eliminations do not balance.** The live period's set is
   debit 2,590,000 vs credit 2,630,000 — **out of balance by 40,000 KES**. The
   generator deliberately leaves a within-tolerance gap "unrecorded"
   (lines 113-117 of the function). An elimination set is a journal entry; a
   one-sided 40,000 injects a 40,000 hole into the consolidated balance sheet.
2. **The live configuration hides the residual rather than accounting for it.**
   The only rule row sets `tolerance_amount = 40000` with policy `refuse` on
   the balance class — a materiality tolerance sized exactly to swallow a
   structural translation residual.
3. **No drill-down from an elimination leg.** `source_evidence` stores
   `source_account_ids` and `entry_count`, and nothing in
   `ConsolidationEliminations.tsx` renders them; there is no leg → intercompany
   position → journal entry path. The log claims this exists.
4. **No default rule templates.** A new group starts with zero rules, so the
   engine falls back to tolerance 0 / `refuse` and the first run always fails.
   This contradicts the product's own default-chart-of-accounts principle.
5. **No period control.** Nothing consults the fiscal-period/close machinery
   that already exists elsewhere in finance; a closed period's eliminations can
   be silently deleted and regenerated.
6. **No audit trail and no reversal.** Regeneration deletes prior rows; only
   `generated_by`/`generated_at` on surviving rows remain. Nothing records who
   ran what, the before/after totals, or a reversal.
7. **The remedy loop is still unproved end-to-end** as a signed-in user.

## How mature systems handle these points

Oracle FCCS/NetSuite, Dynamics 365, SAP S/4 group reporting and Odoo's
consolidation module all agree on four things this system currently misses:
eliminations are posted as **balanced journals** (a rounding tolerance decides
whether the plug is auto-posted, never whether the plug is skipped); the
residual from IAS 21 / ASC 830 retranslation belongs in the **translation
reserve (CTA)**, not in a tolerance; groups ship with **pre-built elimination
rule templates** (IC AR/AP, IC revenue/COGS, investment vs equity); and every
run is **audited, period-controlled and reversible**. That is the gap list
below, in dependency order.

## Execution order

### Step 7.2 — Balanced eliminations invariant (blocking; do first)
- Rewrite the tolerance branch: a difference is **always posted**. Tolerance
  only chooses the destination — at or below tolerance the plug goes to the
  configured rounding destination automatically (CTA for cross-currency,
  difference account otherwise); above tolerance the current refuse/CTA/
  difference policy applies unchanged.
- Add a server-side invariant: per group/period/class, `sum(debit) = sum(credit)`,
  enforced by a verification function the generator calls before it returns, so
  an unbalanced set can never be committed.
- Expose the invariant in `ConsolidatedStatements` from the server's
  `is_balanced`, and correct the live tenant: reset the 40,000 tolerance to a
  rounding-scale figure, set the balance class to carry translation residual to
  the reserve, regenerate 2026-08, and prove the 40,000 lands in the reserve.
- Extend `supabase/tests/consolidation_eliminations_test.sql` with a
  balanced-set assertion for same-currency, cross-currency, within-tolerance
  and above-tolerance pairs.

### Step 7.3 — Default rule templates
- Seed the standard classes for every new group (intercompany balance,
  intercompany trading) with sane defaults — cross-currency residual to the
  translation reserve, rounding-scale tolerance — created at group creation and
  backfilled for existing groups, fully overridable in settings.
- Settings shows which values are system defaults versus user overrides.

### Step 7.4 — Drill-down and deep linking
- Leg → the translated intercompany positions consumed → the source accounts
  and journal entries behind them, using existing GL/account-register routes.
- Statement line → the eliminations that moved it; eliminations report → group
  and period preselected from the statement's context.
- Difference legs explain themselves: policy, tolerance, both currencies, rate
  class used.

### Step 7.5 — Audit trail
- Append-only `consolidation_elimination_events`: who, when, group, period,
  class, action (generate / regenerate / rule change / reversal), row counts and
  debit/credit totals before and after, refusal cause when it failed.
  Insert-only from the engine and the rule triggers, readable by the same roles.
- Surfaced as a run history panel on the eliminations report.

### Step 7.6 — Period control and reversal
- Refuse generation and regeneration for a closed accounting period, reusing
  the existing period-status primitive rather than a new one.
- An explicit reversal action requiring a reason, which clears the set for the
  period and records the reversal in the audit log; no silent overwrite.

### Step 7.7 — Realistic scenario proof
Seed, in a dedicated test organization (never the live group), the scenarios the
parent prompt names: independent companies, differing charts of accounts,
cross-currency parent KES / subsidiary USD, an intercompany sale, a reciprocal
AR/AP pair, translation with CTA, closed-period refusal, double-run
idempotence, and a member of another organization receiving nothing. Each
assertion runs in SQL so it is executed evidence, not narration.

### Then Brick 8
Persisted, versioned consolidation runs — built on 7.5's audit log and 7.6's
period control, not before them. Ownership/NCI and consolidated cash flow stay
out of scope, with no placeholders.

## Checkpoint discipline

Each step ends with its own section in `.lovable/consolidation-brick-log.md`:
what was verified by execution, what changed, the accounting rule now enforced,
the security boundary, and what remains intentionally absent. The log's earlier
Brick 7 claims about drill-down get corrected rather than left standing.

## Technical notes

- No second FX resolver and no second accounting engine: everything continues to
  consume `consolidation_member_translation_rates` and the authoritative finance
  primitives.
- All arithmetic stays in SQL; the architecture tests in
  `src/test/architecture/` are extended to guard the new surfaces.
- Live-session limitation: this project uses an external Supabase project, so
  the sandbox cannot mint a preview session. UI paths are proved by architecture
  tests plus SQL behaviour suites, and any step needing a signed-in click is
  reported as such instead of claimed green.
