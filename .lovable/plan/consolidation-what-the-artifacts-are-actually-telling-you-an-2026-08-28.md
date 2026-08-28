# Consolidation — what the artifacts are actually telling you, and the repair order

Everything below was verified this session against the live database, the SQL
engine source, the page code and the two PDFs you uploaded. Nothing is carried
over from the previous agent's notes.

Short answer to your question: **it is not you.** Two of the three things you
questioned are genuine defects that would fail an audit, and the third (the red
residual banner) is the system correctly reporting a real accounting problem
that was then papered over with a fitted tolerance.

## A. The Trial Balance says "Out of balance by KES 1,960,000". It is wrong — the group actually balances.

The TB footer computes its balance proof by summing the **period movement**
debit and credit columns (KES 2,077,212.00 vs KES 117,212.00). But the
translation reserve figure is a **closing-balance** plug, not a movement, so
those two columns can never tie in a translated group TB. The correct proof is
on closing balances, and it ties exactly:

```text
Assets            77,840,867.60
Liabilities        2,590,249.60
Equity + reserve  64,878,843.40
Result             10,371,774.60
Sum of L + E      77,840,867.60   -> in balance
```

So a corporate reader is being told their consolidated trial balance is broken
when it isn't. Related: the reserve row does not roll forward either —
opening 1,738,443.40 plus debit 1,960,000.00 does not reach closing
-221,556.60, because opening, movement and closing are each computed as
independent plugs.

## B. The Consolidated Balance Sheet's totals are pre-elimination, and "in balance" is asserted against the wrong column.

The line rows come from the eliminated projection; the totals block and the
"is balanced" verdict come from `get_consolidated_statement_totals`, which sums
the **non-eliminated** lines. Verified in the function body and in the page
(`ConsolidatedStatements.tsx` line 259). The printed effect:

| Printed | Value | Actual consolidated |
| --- | --- | --- |
| Total assets | 77,840,867.60 | 75,209,127.60 |
| Total liabilities | 2,590,249.60 | 9.60 |
| Total equity | 75,250,618.00 | 75,209,118.00 |

The printed equity total does not even equal the sum of the equity lines
printed directly above it (gap: exactly the 41,500 residual). The consolidated
column does balance — the totals row is simply reading the wrong source.

## C. The red residual banner — the accounting substance

The two elimination rules in this tenant carry tolerances of **41,500.00** and
**1,500.00**, which are exactly the size of the two observed gaps. The system's
own seeded default is 1.00. The tolerances were fitted to the data so the run
would stop refusing. Worse, both rules say `difference_policy = refuse`, but
the engine plugs to the reserve whenever a gap is *inside* tolerance and never
consults the policy — so the "Policy in force: Refuse the run" chip on that
screen is not the policy that ran.

The substance of each residual:

- **KES 40,000 (balances).** The parent holds a KES 2,630,000 receivable; the
  subsidiary holds a USD 20,000 payable. They matched at the trade rate 131.5
  and diverge at the closing rate 129.5. That is an **unrecorded exchange loss
  on the parent's foreign-currency intragroup monetary item**. IAS 21.45 puts
  exchange differences on intragroup monetary items in profit or loss unless
  the item forms part of the net investment in a foreign operation. Carrying it
  to the translation reserve by default is not correct, and the real remedy is
  member-level period-end revaluation, not a consolidation plug.
- **KES 1,500 (trading).** Posted as Dr Income 1,500 / Cr reserve 1,500 — that
  removes group revenue into equity. Both sides of intragroup trading translate
  at the same average rate, so a trading mismatch is never a translation
  difference. It means one side is unrecorded, or the margin is sitting in the
  buyer's inventory (unrealised profit, eliminate against inventory), or it is
  a timing cut-off. Never the reserve.

## D. The PDFs — yes, they are being generated for the sake of it in three specific ways

1. **Wrong entity on the masthead.** Both group artifacts are headed *Mombasa
   Port Services Limited, Mombasa KE, Tax ID P052001234X, Headquarters (HQ)* —
   a subsidiary and a branch — for a Joshua Holdings Group report.
2. **Traceability is stripped in the export.** The contribution rows export an
   empty account code and name by construction, which is why the PDF shows six
   identical `- - Joshua Holdings (parent)` rows under G1900. On screen those
   are 1015 Cash on Hand, 1100 AR, 1340 Undeposited Funds. An auditor cannot
   tie the artifact back to any ledger.
3. **"Run 12d1ea08" / "Run 45773053" are not consolidation runs.** They are
   per-export identifiers — the same period printed six minutes apart carries
   two different "Run" numbers. `consolidation_runs` is empty: **no
   consolidation run has ever been created in this system.**

The tiny type has a single named cause: PDF typography is pinned per report in
the server report registry, and consolidation reports are not registered at all
and send no report type, so they miss the `statement` profile (10pt, taller
rows) that the Balance Sheet, P&L and Trial Balance receive, and fall through
to inferred density. The registry-coverage test that enforces this on statutory
statements simply does not cover consolidation.

## E. Configuration gaps

- The group's translation reserve points at **account 3050 owned by Joshua
  Holdings**, a member's own GL account, while every other group line uses the
  group chart (G1100, G2100, G3900). The group's reserve should be a group
  account.
- Nothing bounds or justifies an elimination tolerance, and nothing records who
  widened one or why — which is how 41,500 got in.
- Brick 8 remains open on its own terms: lifecycle functions exist, zero runs
  have ever executed, and `anon` still holds EXECUTE on all three.

## Repair order

Each step lands complete — SQL, guard, surface, artifact, scenario test, brick
log — before the next begins.

**R1 — Stop the artifacts from lying.** TB balance proof moves to closing
balances; balance-sheet totals and the balanced verdict read the eliminated
projection. Scenario assertions that a translated group TB proves on closing
balances and that totals equal the sum of the printed consolidated lines.

**R2 — Artifact identity and traceability. DONE (2026-08-28).**
`ExportConfig.reportingEntityBusinessId` declares the issuing entity; the three
consolidated pages (TB, statements, eliminations) set it to the group's
`parent_business_id` and force `branchId: null`, and `enrichExportConfig` now
lets that declaration and an explicit page currency win over the ambient
browsing entity — a group artifact can no longer bear a subsidiary's legal
name, logo, branch scope or base currency. Contribution rows export the
member's own account code and name instead of blanks. The PDF footer hash is
labelled `Export ref`, not `Run`, so a per-rendition hash is no longer read as
a consolidation run id. `render-report` and `process-scheduled-reports`
redeployed; `pdfCache` bumped to v7.

**R3 — Register consolidation reports.** Add them to the server report registry
with `presentationProfile: "statement"` pinned, and extend the registry
coverage test so a consolidated statement can never again ship unpinned.

**R4 — Make the residual policy honest.** Apply `difference_policy` inside
tolerance as well as outside; forbid trading residuals from reaching the
translation reserve; disclose any residual as a named reconciling line on the
face of the consolidated statements rather than inside equity; bound tolerances
and record who changed one and why; reset this tenant's fitted 41,500 / 1,500
to a defensible policy.

**R5 — Remove the cause, not the symptom.** Member-level period-end revaluation
of foreign-currency intragroup monetary balances, so the KES 40,000 is
recognised where it belongs and the residual disappears legitimately.

**R6 — Make the reserve articulate.** Opening plus movement equals closing for
the translation reserve, and move the group reserve onto a group account
instead of the parent's 3050.

**R7 — Close Brick 8 for real.** Revoke the `anon` EXECUTE grants and drive one
genuine create → finalize → supersede run against this group, with the frozen
figures proven immune to a later member rate edit. Only then Brick 9 (ownership
and non-controlling interests).

## Deliberately not in this plan

No NCI, no equity method, no consolidated cash flow, and no scaffolding for
them. No new tables until R4 needs one.
