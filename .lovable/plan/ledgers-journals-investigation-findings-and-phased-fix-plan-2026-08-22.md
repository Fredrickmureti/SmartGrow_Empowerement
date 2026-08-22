# Ledgers & Journals — investigation findings and phased fix plan

Scope: Trial Balance, General Ledger, Journal Report, plus the Account Register that
shares their data path. Investigation only so far; nothing has been changed.

## A. Accounting model (established, then checked against the code)

These are three distinct accounting artifacts, not three skins on one query. The
current three-way split is **correct and must be preserved**:

- **Trial Balance** — account-level proof, point in time or per period. Unit = account.
  Must show opening / period movement / closing, and prove total debits = total credits.
- **General Ledger** — account-centric detail for a period, multi-account. Unit = journal
  line grouped under its account. Must show opening balance, movements, running balance,
  closing balance, and a debit=credit proof across the run.
- **Journal Report (posting journal)** — entry-centric chronological record. Unit = journal
  entry. Must show each entry whole (all its lines, balanced), with journal book, source
  document, status, reversal linkage and author. It must **not** carry account opening or
  running balances — that would be pretending to be a ledger.
- **Account Register** — single-account operational running record; a drill-down view of
  the GL, not a fourth report engine. Already exists at `/finance/account-register`.

Conclusion on completeness: no new report engines are required. The gaps are inside the
three existing reports plus a missing *journal-entry-level* view in the Journal Report.
A "comparative / adjusted / detailed trial balance" is a filter and column variation of
Trial Balance, not a separate report.

## B. Verified implementation facts

Data path, screen:
- TB → `useFinancialReport` → RPC `get_account_movements` + `accounts` read (client-side math).
- GL and Account Register → `useGeneralLedger` → RPC `get_general_ledger` (server SQL,
  client running-balance math).
- Journal Report → direct PostgREST select on `journal_entries` + nested lines. No RPC.

Data path, PDF/CSV/scheduled:
- Screen exports pass prebuilt client rows (no `dateFrom`/`dateTo` in the export config),
  so on-demand exports currently match the screen.
- Scheduled reports and the preview dialog use `supabase/functions/_shared/reportDataEngine.ts`
  (`buildTrialBalance`, `buildGeneralLedger`, `buildJournalReport`) — a **second, independent
  implementation** of the same accounting math.

Both RPCs are SECURITY DEFINER, call `finance_can_read_org(_org_id)`, and validate that the
business and branch belong to the org. Cross-org / cross-business isolation on TB and GL is
**correct** and must be preserved.

## C. Confirmed defects (evidence-backed)

1. **Reversed originals vanish from the ledger — critical accounting defect.**
   Every read path filters `status = 'posted'`. In live data, `JE-00009` (KES 50,000)
   has `status = 'reversed'` while its reversal `JE-00009-REV` (KES 50,000) is `posted`.
   Result: the reversal is reported without the original. Account balances are wrong by
   the reversal amount, and history is rewritten. Correct treatment: a reversed entry
   stays in the ledger, marked reversed, alongside its reversal. Only `draft` and `void`
   are excluded from balances (void may still be listed in the Journal Report as void).

2. **Broken reversal linkage.** `JE-00009.reversed_by_id` points to a UUID that does not
   exist in `journal_entries`, while `JE-00009-REV.reversal_of_id` is correct. The
   back-pointer is unreliable; reports must not depend on it until it is repaired.

3. **Trial Balance has no period.** The page hardcodes `dateFrom = '1970-01-01'` and only
   exposes an "as of" date. So the Opening column is always just `accounts.opening_balance`
   (zero for all 154 accounts in this tenant) and Movement = inception-to-date. The
   six-column opening/movement/closing presentation is therefore not what it claims to be.
   TB needs a real period (from/to) with opening = balance before `from`.

4. **Journal Report is silently truncated and mis-scoped.**
   - No pagination: PostgREST caps the result at 1000 entries with no warning.
   - Branch filter uses `branch_id.eq.X OR branch_id.is.null`, while TB and GL use strict
     equality. Same filter, three different answers.
   - Missing entry-level accounting fields: journal book, status, reversal linkage,
     created/posted by, currency, branch, entry-level reference. It is currently a line
     dump grouped by entry, not a posting journal.

5. **Server (scheduled/PDF) engine diverges from the screen.**
   - `buildTrialBalance` / `buildGeneralLedger` / `buildJournalReport` take no `branchId` —
     a branch-scoped schedule silently prints whole-business figures under a branch masthead.
   - `getGLAccountBalances` and the GL/JR builders read raw `journal_entry_lines` with no
     pagination → **balances themselves are wrong past 1000 lines**.
   - Account scoping differs: server uses strict `business_id = X`; the client hook uses
     `business_id = X OR business_id IS NULL`.
   - `buildJournalReport` returns a flat line list with no entry grouping or entry subtotals,
     so the scheduled PDF is a different document from the screen.

6. **Branch-scoped opening balances are overstated.** `get_general_ledger` adds
   `accounts.opening_balance` in full for every branch filter, then adds branch-filtered
   prior movement. Harmless today (all opening balances are 0) but wrong by construction.

7. **Duplicated accounting math.** Opening/closing/running-balance and debit-normal logic
   exist in at least four places: `useFinancialReport`, `useGeneralLedger`,
   `get_general_ledger` SQL, and `reportDataEngine.ts`. This is the root cause of items 3–6.

## D. Correct behaviour that must be preserved

- Three separate reports with separate accounting purposes (§A).
- SECURITY DEFINER RPCs with `finance_can_read_org` + business/branch ownership checks.
- The consolidation gate: refusing to render a cross-company statement instead of summing
  ledgers without eliminations.
- Reference model: `entry_number` (ledger identity), `reference` (source document number),
  `source_type`/`source_id` (internal drill-down FK). No new identifiers.
- ADR-0020 narration convention and ADR-0123 single-posting-monopoly.
- Screen exports built from the same rows the screen renders.

## E. Phased execution order (one capability finished before the next)

**Phase 1 — Ledger visibility contract (shared prerequisite).**
Define, in one place, which journal statuses are ledger-visible: `posted` and `reversed`
count toward balances; `draft` never; `void` excluded from balances, listed as void in the
Journal Report only. Apply it to `get_account_movements`, `get_general_ledger`, the Journal
Report query and the server builders. Repair the dangling `reversed_by_id` and add a
constraint/trigger keeping the pair consistent. Tests: a reversed entry plus its reversal
nets to zero in TB and appears as two lines in GL.

**Phase 2 — Trial Balance.**
Real period selection (from/to, fiscal-period aware) with opening = pre-period balance;
keep the as-of preset. Fix branch-aware opening. Balance proof on closing debits vs credits.
Comparative period column reuse of the existing `comparisonDateFrom/To` support. Tests:
opening + movement = closing per account; totals balance; date and fiscal-year boundaries.

**Phase 3 — General Ledger.**
Branch-correct opening balance in `get_general_ledger`. Add entry status / reversal flag,
journal book, branch and currency to the RPC output and the columns. Keep the existing
running balance and drill-through. Reconciliation test: GL closing per account = TB closing
per account for the same scope and period.

**Phase 4 — Journal Report → posting journal.**
Move to a paginated RPC (`get_journal_report`) mirroring the GL security checks; strict
branch equality; add journal book, status, reversal linkage, posted-by, currency, entry
reference; keep entry grouping with per-entry balanced subtotals and add a period grand
total. No opening/closing balances. Tests: entry-level debit = credit; no truncation at
>1000 entries; branch and business isolation.

**Phase 5 — Collapse the duplicate engines.**
Make the server builders call the same RPCs the screen uses (with `branchId` threaded
through), deleting the parallel PostgREST math in `reportDataEngine.ts`. Add an architecture
test forbidding new client- or edge-side ledger balance math outside the RPCs.

**Phase 6 — Multi-currency presentation.**
Report in base currency as today; surface `journal_entries.currency` / `exchange_rate` as
informational columns in GL and the Journal Report. No new FX logic — reuse the existing
FX engine. Deferred deliberately until 1–5 land.

## F. Validation

Reconciliation tests derived independently from `journal_entry_lines`, not from the report
code: TB balances; TB ↔ GL ↔ Account Register agreement for the same account and period;
reversal and void treatment; draft exclusion; locked-period reads; date/fiscal boundaries;
branch and business isolation (including a multi-business user); >1000-row runs; screen vs
PDF vs scheduled-PDF parity.

## G. Scope boundaries

Out of scope for this wave: new report types, UI restyling, consolidation/eliminations,
FX revaluation logic, and any change to the posting engine. `supabase/functions/_shared/pdf`
is not touched; if Phase 5 changes `_shared/reports`, redeploy `render-report` and
`process-scheduled-reports` and bump `v` in `src/services/reports/pdfCache.ts`.

Note: the Supabase project is already connected (`jkszmrroyjfdwokbkzis`); no new connection
is needed for this work.
