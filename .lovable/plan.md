# Fix FX Exposure error + rebuild the Reports navigation

## 1. The crash: `column b.default_currency does not exist`

Verified against the live database: `public.businesses` has **`base_currency`**, not
`default_currency`. Both new functions — `fx_exposure_by_currency` and
`fx_exposure_open_items` — reference `b.default_currency`, so every call fails at
runtime. That is why the page renders "Error loading report".

Fix: one migration that replaces both functions with `b.base_currency`. No signature,
security or logic change otherwise — they stay SECURITY DEFINER, business-gated, and keep
returning `null` (never `1`) when no rate is on file.

I will also grep the rest of the FX SQL surface for the same wrong column so this class of
bug is cleared in one pass, not one page at a time.

## 2. The missing links: the sidebar Reports list is hand-maintained and stale

There are two problems, and they have the same root cause.

**Root cause.** `src/apps/finance/nav.ts` and `src/apps/reports/nav.ts` each hardcode a
list of report links. `src/services/reports/ReportRegistry.ts` already is the catalogue of
every report (id, title, category, path, permission, keywords) and it is what the Reports
landing page and search use. The two lists have drifted: the registry has ~24 finance
reports, the sidebar shows 15. Missing today: FX Revaluation, FX Exposure, Bank
reconciliation, Control account reconciliation, Inventory–GL reconciliation, Stock,
Stock adjustments, Stock transfers.

**Fix.** Stop hand-maintaining the list. Derive the Reports sub-tree from the registry so a
new registry row shows up in the sidebar automatically — the same rule ADR-0062 applies to
payroll reports ("registry-driven, no hardcoded report keys in the UI").

**Grouping.** Today all reports sit at one flat level, which is exactly the chip-wall the
platform already rejected once. Enterprise finance suites (SAP, NetSuite, Oracle) group the
report catalogue by *accounting family*, not alphabetically. The registry already carries a
`category`, so the sidebar will render family → reports:

```text
Reports
  Financial statements     P&L, Balance sheet, Financial statements
  Ledgers                  Trial balance, General ledger, Journal
  Receivables & payables   Aged receivables, Aged payables, Partner ledger, Sales
  Cash & banking           Cash flow, Bank reconciliation
  Currency & FX            FX revaluation, FX exposure
  Tax                      Tax reports
  Budget & assets          Budget vs actual, Depreciation
  Inventory                Stock, Stock adjustments, Stock transfers
  Audit & integrity        Audit trail, Run history, Control-account recon, Inventory-GL recon
  Intelligence             Management, Business intelligence
```

Rules applied so nothing lands twice: a report appears under exactly one family; the P&L
and Balance-sheet views of Financial statements stay as children of that one entry rather
than as siblings; cross-module report entry points (HR, Payroll, POS, Projects,
Timesheets) stay out of the Finance sidebar — those modules own their own nav.

## 3. Technical notes

- Add a `familyOf(category)` mapping plus a `buildReportsNav()` helper next to the registry;
  `finance/nav.ts` and `reports/nav.ts` both consume it, so the two navs can never diverge
  again.
- `WorkspaceSidebar` currently renders only one level of `children`. It needs to recurse one
  more level so a family can collapse; the change is local to that component and keeps the
  existing active-path highlighting.
- Registry entries are already permission-tagged; the nav builder honours `permission` so
  users only see reports they may open.
- A guard test asserts every registry report whose path starts with `/finance/reports/`
  is reachable from the Finance nav — the drift that caused this cannot come back silently.
