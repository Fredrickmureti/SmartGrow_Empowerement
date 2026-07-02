# Unified Reporting Engine

Single funnel for every PDF the platform produces. All entry points
delegate to `renderReport()` so branding, format profile, footer
disclosure, and the `report_run_log` audit trail are guaranteed
identical across modules.

## Pipeline

```
Client (React)                  Edge function                    Shared funnel
─────────────                   ─────────────                    ─────────────
ReportContext.enrich(config) ─▶ render-report (canonical)        renderReport()
                                ├─ prebuilt mode  ───────────┐     1. entitlement (caller)
                                │   {columns, rows, ...}     │     2. branding (cached)
                                └─ server-build mode  ───────┤     3. registry resolve
                                    {reportType, dateFrom..} │        (columns, profile,
                                                             │         orientation, subtitle)
                                generate-report-pdf ─────────┤     4. financial vs operational
                                  (DEPRECATED shim, warns)   │        masthead
                                                             │     5. drawDataTable
process-scheduled-reports ──────────────────────────────────▶│        (parens for negatives,
  (cron)                                                     │         "—" for empty)
                                                             │     6. drawFinalFooter
                                                             │        "Generated {ts} by {user}
                                                             │         • {org} • Run {hash}"
                                                             │     7. INSERT report_run_log
                                                             ▼        (best-effort, non-blocking)
                                                        Uint8Array PDF
```

## Format profiles

| Profile        | Header                                             | Used by                                           |
|----------------|----------------------------------------------------|---------------------------------------------------|
| `financial`    | Centered statutory masthead (no logo): COMPANY → Title → Period → Subtitle → Prepared on | balance_sheet, trial_balance, income_statement, profit_and_loss, cash_flow |
| `operational`  | Logo left, title right (existing)                  | every other report (default)                       |

Number formatting is uniform across both profiles: negatives in parentheses
`(KES 1,234.00)`, empty cells as `—`, two fraction digits with grouping.

## Adding a new report

1. Add the key to `REPORT_SPECS` in `columnSpecs.ts` with `columns`,
   `orientation`, optional `formatProfile` + `subtitle`.
2. If server-built, add a `build*` function in `reportDataEngine.ts`
   and a `case` in `render-report/index.ts`'s `buildReportData`.
3. Frontend pages emit `ExportConfig`; `ReportContext` injects
   `organizationId`, business, currency. **No page-level branding code.**
   Spread `enrichExportConfig({})` into the config so the canonical
   render-context is always attached:

   ```tsx
   const { enrichExportConfig } = useReportExportContext();
   ...
   <ReportExportButtons getExportConfig={() => ({
     title: "Headcount Report",
     columns: [...],
     rows: [...],
     ...enrichExportConfig({}),
   })} />
   ```

## Audit trail

Every render inserts one row into `public.report_run_log`:

| Column           | Notes                                            |
|------------------|--------------------------------------------------|
| `organization_id`| RLS scope                                        |
| `business_id`    | optional sub-entity                              |
| `user_id`        | from JWT; null for cron / system runs            |
| `report_type`    | registry key, or `"ad_hoc"`                      |
| `params_jsonb`   | call shape for "rerun this" debugging            |
| `run_hash`       | 8-char SHA-1 prefix, also printed in the footer  |
| `byte_count`     | PDF size                                         |
| `status`         | `"ok"` / `"error"`                                |
| `created_at`     | insertion timestamp                              |

A user looking at a printed report can read the footer hash and ask
"who generated this and when?" — answered by a single SELECT:

```sql
select created_at, user_id, report_type, params_jsonb
from public.report_run_log
where run_hash = '3f7a2e1c';
```

The table is created by the Stage A migration:
`supabase/migrations/20260417000000_report_run_log.sql`. The renderer
gracefully no-ops when the table is missing, so a missing migration
never blocks a PDF — the audit just goes silent.

## Drill-down (`_meta`)

Rows produced by `reportDataEngine.ts` carry an optional `_meta` field.
The PDF renderer ignores it; `render-report` returns it intact in JSON
mode so report viewers can wire row clicks to the relevant detail page.

### `_meta` contract

```ts
interface ReportRowMeta {
  accountId?:      string;   // → /finance/accounting/accounts/:id
  journalId?:      string;   // → /finance/accounting/journal-entries/:id
  sourceDocType?:  "invoice" | "bill" | "credit_note" | "debit_note"
                 | "payment" | "journal_entry" | "expense" | "asset";
  sourceDocId?:    string;
  partnerId?:      string;
  partnerType?:    "customer" | "supplier";
}
```

### Resolution priority

Most specific wins. The React-side resolver lives at
`src/hooks/useReportDrilldown.ts` (`getDrilldownTarget`):

1. `sourceDocType` + `sourceDocId` → originating document
2. `journalId` → journal entry detail
3. `accountId` → account ledger
4. `partnerId` + `partnerType` → partner statement

### Per-report `_meta` keys (server-built reports)

| Report           | `_meta` keys present                              |
|------------------|---------------------------------------------------|
| `general_ledger` | `accountId`, `journalId`, `sourceDocType`, `sourceDocId` |
| `partner_ledger` | `partnerId`, `partnerType`, `journalId`           |
| `journal_report` | `journalId`, `accountId`                          |
| `trial_balance`  | `accountId`                                       |
| `balance_sheet`  | `accountId`                                       |
| `income_statement` / `profit_and_loss` | `accountId`                  |
| `audit_trail`    | `sourceDocType`, `sourceDocId`                    |
| `invoice_aging`  | `sourceDocType="invoice"`, `sourceDocId`, `partnerId` |
| `aged_payables`  | `sourceDocType="bill"`, `sourceDocId`, `partnerId` |

Operational listings without a clear source-of-truth row (e.g. salary
band distributions in HR Reports) intentionally omit `_meta`.

## Known limitations

- **POS thermal receipts.** `useDocumentPrint` accepts `pos_receipt` as a
  document type but `generate-document` aliases it to the regular
  `receipt` template. Thermal printers use 80mm-wide paper which the
  current `PdfBuilder` page-size enum (A4 portrait/landscape) does not
  yet handle. Tracked as a follow-up: introduce
  `pageSize: "thermal"` in `PdfBuilder` and a dedicated narrow-column
  layout. Scope intentionally excluded from the current closure plan.
