# Consolidation — verified handover (2026-08-27 late) and Step 7.4: drill-down

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the live `AccrualFlowCorporation` database and the repo,
not against the log.

Confirmed **true**:

- **Step 7.2 (balanced eliminations) is real.** `consolidation_eliminations_balance`
  exists as a server function, and the live 2026-08 set now balances exactly:
  intercompany balance 2,631,740 debit = 2,631,740 credit (5 legs, 1 difference
  leg), intercompany trading 1,500 = 1,500 (2 legs, 1 difference leg). The
  previously reported 40,000 one-sided hole is gone; the residual is carried as
  an explicit difference leg rather than being dropped.
- **Step 7.3 (default policy templates) is real.** `consolidation_elimination_rules`
  carries `is_system_default` and `seeded_at`; `_consolidation_seed_default_rules`,
  the group-creation trigger, the human-edit flag trigger and the caller-facing
  reseed function all exist in the database. The live group's two customised
  policies (tolerance 41,500 and 1,500, policy `refuse`) are untouched and
  correctly reported as customised rather than default, and no group is missing a
  class.
- The engine surface is intact: generate, diagnose, intercompany flows,
  `_eliminated` statement RPCs, CTA reconciliation, the eliminations report, the
  three-column consolidated statements, and the settings policy editor.

Confirmed **false / still outstanding**:

- **Drill-down does not exist.** The Brick 7 log section claims the eliminations
  report offers "drill-down to the intercompany positions consumed". It does not.
  `source_evidence` (`source_account_ids`, `entry_count`,
  `net_debit_before_elimination`) is written by the engine and is referenced
  nowhere in `src/` — the report never reads it, and there is no path from a leg
  to a position, account or journal entry. That log claim is corrected here.
- **The live group's 41,500 tolerance is still a materiality-sized figure with
  policy `refuse`,** not the rounding-scale default. Step 7.2 made the set
  balanced; it did not resolve whether that tolerance is the accountant's
  intended policy. This stays an accountant decision, surfaced but not
  overwritten.
- **The remedy loop is still unproved as a signed-in user** — this project uses an
  external Supabase project, so the sandbox cannot mint a preview session.

Nothing later than 7.3 was started. Resuming at **Step 7.4**.

## Phase 2 — Plan additions justified by the verification

Two items the previous plan did not name, added to 7.4's scope because they are
inherent to drill-down:

1. **Cross-company drill-down is an authorization event, not a link.** The group
   report is visible to an org owner/admin; the member company's ledger is
   business-scoped. A leg must only offer a ledger link for a business the
   viewer can actually open, and the server, not the browser, decides that.
2. **Evidence today is thin.** `source_evidence` holds account ids and an entry
   count. Naming an account and counting entries is not traceability; the
   drill-down needs the positions and the actual entries behind them, returned
   by a server function that reads the same primitives the generator reads, so
   preflight, run and evidence cannot disagree.

Unchanged remaining sequence after this step: 7.5 audit trail, 7.6 period
control and reversal, 7.7 realistic scenario proof, then Brick 8 (persisted,
versioned runs). Ownership/NCI and consolidated cash flow stay out of scope,
with no placeholders.

## Step 7.4 — Drill-down: every consolidated number explains itself

### Database

- `consolidation_elimination_evidence(group, period_start, period_end, class,
  declaring_business, counterparty_business, group_account)` — read-only,
  SECURITY INVOKER, fixed `search_path`, behind the same owner/admin/super-admin
  organisation check as generation. For one elimination leg it returns the
  translated intercompany positions consumed (both companies, both source
  accounts with code and name, source-currency and presentation-currency
  amounts, the translation rate class applied), and, underneath each position,
  the journal entries behind it (entry id, number, date, business, line amount)
  so a figure resolves to documents rather than to a count. Reads the same
  `consolidation_intercompany_flows` / translation primitives as the generator;
  no new arithmetic, no second FX resolver.
- `consolidation_line_eliminations(group, period, group_account)` — which
  elimination legs moved a given consolidated statement line, for the
  statement → eliminations path.
- Both functions return, per referenced business, a server-computed
  `viewer_can_open_ledger` flag so the client never decides access itself.
  `anon` revoked; grants match the existing consolidation functions.

### Surface

- **Eliminations report:** each leg expands into its evidence — positions, then
  entries. A difference leg explains itself instead of expanding: policy in
  force, tolerance, both currencies, the rate class used, and the residual, from
  the diagnosis the server already produces. Entry rows deep-link to the
  existing journal entry detail route and account rows to the existing general
  ledger route (`account_id` + `date_from` + `date_to`), only when the server
  says the viewer can open that business's ledger; otherwise the row states
  plainly that the ledger belongs to a company outside the viewer's access.
- **Consolidated statements:** the Eliminations column amount on a line opens
  the eliminations report with group, period and group account preselected via
  query params, matching the `?consolidationGroup=` convention Step 7.1
  established in finance settings.
- No arithmetic and no refusal-text sniffing in the browser — the existing
  architecture guard is extended to cover the new components.

### Verification for this step

- New `supabase/tests/consolidation_elimination_evidence_test.sql`: evidence sums
  reconcile to the leg it explains; a same-currency and a cross-currency leg both
  resolve to entries; a difference leg returns its policy context and no phantom
  positions; a member of another organisation receives nothing; `anon` is
  refused.
- Architecture suite extended and re-run, `tsgo --noEmit` clean, live rows re-read
  against the report.
- Checkpoint appended to `.lovable/consolidation-brick-log.md`, including the
  explicit correction of the earlier false drill-down claim.

### Intentionally absent after this step

Audit/run history (7.5), period control and reversal (7.6), persisted versioned
runs (Brick 8), NCI and consolidated cash flow. No scaffolding or disabled
controls for any of them.
