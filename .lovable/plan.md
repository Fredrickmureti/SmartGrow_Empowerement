
## Root cause

CSV files open as "Chinese"/gibberish in Excel because our client-side CSV writers emit raw UTF-8 **without a BOM**. On Windows, Excel opens `.csv` in the OS's ANSI codepage (CP1252/CP936/etc.) unless a UTF-8 BOM (`\uFEFF`) is present. Any non-ASCII byte (accented names, currency symbols, KES/€/Kes payslip text, Arabic/Swahili, em-dash from formatters) is then mis-decoded — on CJK Windows locales this shows as Chinese characters.

Server-side we already do it correctly:
- `supabase/functions/_shared/exports/reportCsv.ts` and `statementCsv.ts` prepend `\uFEFF`, use CRLF, and are RFC 4180 compliant.
- `render-report`, `generate-document`, `generate-payroll-document`, `generate-statutory-return` go through those builders.

The defect is in the **client-side ad-hoc CSV writers** that were never migrated. Every one of them builds a string with `join(",") + "\n"`, wraps it in `new Blob([csv], { type: "text/csv;charset=utf-8" })`, and downloads — no BOM, LF instead of CRLF, inconsistent escaping. That is the exact fingerprint that produces gibberish in Excel.

Confirmed offenders (grep verified):
- `src/hooks/useExport.ts` — hub used by Contacts, Invoices, Bills, Payments, Products, Estimates, Credit Notes, Sales Orders, Purchase Orders, Delivery Notes, Accounts, Recurring Invoices, and more.
- `src/lib/exportMovements.ts` (Inventory stock movements)
- `src/lib/migration/csvTemplates.ts` (Import templates)
- `src/lib/payroll/bankDisbursementExport.ts`
- `src/pages/Expenses.tsx`
- `src/pages/AuditLogs.tsx`
- `src/pages/hr/AttendanceAudit.tsx`
- `src/pages/hr/payroll/PayrollPaymentsSubViews.tsx`
- `src/pages/hr/payroll/PayrollBatchRegister.tsx`
- `src/pages/hr/payroll/LegalOrdersReports.tsx`
- `src/pages/hr/payroll/LegalOrderRemittanceBatch.tsx`
- `src/pages/sales/CustomerLedger.tsx`
- `src/components/accounts/DeleteAllAccountsDialog.tsx`
- `src/components/payroll/PayrollRunDetailsDialog.tsx`

`ReportExportService.exportToCSV` already delegates to the server (correct); it does not need to change.

## Solution — one canonical client CSV writer

Introduce a single Excel-safe CSV service and migrate every client-side exporter to it. Mirror the existing server contract (`_shared/exports/reportCsv.ts`) so client- and server-emitted CSVs are byte-shape identical.

### 1. New module: `src/lib/exports/csv.ts`

Pure functions + one download helper. No React, no Supabase.

```ts
// RFC 4180 + Excel-safe:
//   • UTF-8 with BOM (\uFEFF)
//   • CRLF row separator
//   • quote a cell iff it contains " , ; \r \n or leading/trailing space
//   • escape " as ""
//   • numbers formatted with "." decimal separator, no thousands
//   • booleans → "Yes"/"No" by convention (matches useExport today)
//   • Date/ISO passthrough; Date objects → ISO date (YYYY-MM-DD)
//   • null/undefined → ""
//   • BOM added exactly once at the top of the file

export type CsvColumn<T> = {
  key: keyof T & string;
  header: string;
  format?: (v: unknown, row: T) => string | number | boolean | null | undefined;
};

export type CsvBuildOptions = {
  delimiter?: "," | ";" | "\t";     // default ","
  eol?: "\r\n" | "\n";              // default "\r\n"
  bom?: boolean;                    // default true
};

export function buildCsv<T>(
  rows: T[],
  columns: CsvColumn<T>[] | string[],  // string[] = plain header-driven mode
  opts?: CsvBuildOptions,
): Uint8Array;

export function downloadCsv(
  filenameWithoutExt: string,
  bytes: Uint8Array | string,
): void;   // sets mime "text/csv;charset=utf-8", appends `.csv`, revokes URL
```

Notes:
- Output is always `Uint8Array` (via `TextEncoder`) so Blob construction never re-encodes.
- Blob is `new Blob([bytes], { type: "text/csv;charset=utf-8" })` — the charset parameter is retained for HTTP contexts but the BOM is what actually protects Excel.
- Filename sanitizer strips path separators and non-`[A-Za-z0-9._-]` runs; caller appends the date if desired.

### 2. Migrate all client callers

Replace every hand-rolled CSV block with `buildCsv` + `downloadCsv`. In particular:

- **`src/hooks/useExport.ts`** — rewrite the internal `exportToCSV` primitive to call `buildCsv({rows,columns})` + `downloadCsv`. All 15+ domain exporters (`exportInvoices`, `exportBills`, `exportContacts`, `exportPayments`, `exportProducts`, `exportEstimates`, `exportCreditNotes`, `exportPurchaseOrders`, `exportSalesOrders`, `exportDeliveryNotes`, `exportAccounts`, `exportRecurringInvoices`, …) inherit the fix for free — no per-caller edits needed beyond re-exporting through the new primitive.
- **Payroll / HR pages** (`PayrollPaymentsSubViews`, `PayrollBatchRegister`, `LegalOrdersReports`, `LegalOrderRemittanceBatch`, `PayrollRunDetailsDialog`, `AttendanceAudit`) — replace inline Blob construction with `downloadCsv(name, buildCsv(rows, cols))`.
- **Inventory / Migration / Sales / Finance / Audit** (`exportMovements.ts`, `csvTemplates.ts`, `bankDisbursementExport.ts`, `Expenses.tsx`, `AuditLogs.tsx`, `CustomerLedger.tsx`, `DeleteAllAccountsDialog.tsx`) — same pattern.

Business logic (which rows, which columns, filenames) is untouched — only serialization/encoding/download.

### 3. Guardrails so this cannot regress

- New ESLint rule `no-raw-csv-blob` (in `eslint-rules/`, matching the style of `no-raw-xlsx-in-app.js`): flag `new Blob([...], { type: /^text\/csv/ })` outside `src/lib/exports/csv.ts`. This mirrors ADR-0085's "single-owner rendering" pattern for CSV.
- Vitest architecture test `src/__tests__/architecture.csv-single-writer.test.ts`: scan `src/` for the offending Blob pattern, allowlist `src/lib/exports/csv.ts`.
- Vitest unit tests for `buildCsv`:
  - starts with `\uFEFF`
  - CRLF between rows and terminal CRLF
  - quotes and escapes `,` `"` `\r` `\n` and leading/trailing spaces
  - non-ASCII round-trip (é, ñ, €, 中文, ش) decodes correctly with `TextDecoder("utf-8")`
  - null/undefined → empty cell
  - custom delimiter (`;`) and disabled BOM options

### 4. Server side — verification only

Confirm the existing server exports already emit BOM+CRLF and are the only writers on that side. Test coverage already exists (`reportCsv_test.ts`, `statementCsv_test.ts`). Add a mirrored arch guard `csv-single-writer.server.test.ts` in `supabase/functions/_shared/exports/` asserting no other Deno file synthesizes `text/csv` bytes (allowlist: `reportCsv.ts`, `statementCsv.ts`, `govFileWriter.ts`, `persistArtifact.ts` pass-throughs).

### 5. ADR

Add `docs/adr/00xx-csv-export-ownership.md` (peer of ADR-0085) declaring:
- Client CSV bytes are owned by `src/lib/exports/csv.ts`.
- Server CSV bytes are owned by `supabase/functions/_shared/exports/*`.
- Both must emit UTF-8 with BOM, CRLF, RFC 4180 quoting.
- Modules never construct `text/csv` Blobs directly.

## Verification

- Manually export from Payroll, Contacts, Invoices, Stock Movements, Audit Logs, Customer Ledger; open in Excel (Windows), LibreOffice Calc, Numbers, Google Sheets. All must render UTF-8 correctly without an import wizard.
- Byte-level: hex-dump first 3 bytes of every exported file — must be `EF BB BF`.
- Vitest + ESLint arch guards green.
- Grep after migration: zero `new Blob(...text/csv...)` occurrences outside `src/lib/exports/csv.ts`.

## Technical details

- No new dependencies; `TextEncoder`, `Blob`, `URL.createObjectURL` are enough.
- Delimiter stays `,` by default; localized `;` is opt-in (some EU Excel locales prefer it, but BOM + `,` is universally accepted — matches SAP/Odoo/NetSuite default).
- CRLF chosen over LF: RFC 4180 §2.1 and required for reliable multi-line cell handling in Excel for Mac.
- BOM is added exactly once by `buildCsv`; callers never concat CSVs. Streaming/large exports (>50MB) are out of scope — they already go through server render pipelines.
- No user-visible UX change: same button, same filename convention, same columns. The only difference is bytes on disk.
