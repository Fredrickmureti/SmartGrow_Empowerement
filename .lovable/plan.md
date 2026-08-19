# Bank Statement Import Crash — Root Cause and Repair

## Root cause (verified in code, not assumed)

The crash is **not** in the reconciliation page, not in a GL-account picker, and
not caused by a malformed file. It happens one step earlier, in the import
wizard's **column-mapping step**.

Chain, traced end to end:

```text
drop file
  → ImportStatementWizardPage.handleFileChange  (src/features/finance/banking/import/ImportStatementWizardPage.tsx:111)
  → parseStatementFile → parseCSVOrExcel        (src/lib/bankStatementParsers/csvParser.ts:32)
       headers = nonEmptyRows[0].map(h => String(h).trim())
  → needsColumnMapping === true  → setStep("map")
  → MapField renders one <SelectItem value={h}> per header  (ImportStatementWizardPage.tsx:657)
  → any header cell that is blank yields value=""           → Radix throws
```

- **Exact component:** `MapField` at the bottom of
  `src/features/finance/banking/import/ImportStatementWizardPage.tsx` (lines
  643-665). Seven instances render on the "Map columns" step, so the crash is
  guaranteed once a blank header exists.
- **Exact empty value:** `value={h}` where `h === ""`.
- **Origin of the empty string:** `csvParser.ts:32`. `sheet_to_json(..., {header:1,
  defval: ""})` pads every row to the sheet's widest column, and the parser takes
  **the first non-empty row** as the header row. A real bank statement — the
  Meridian Commercial Bank export included — begins with preamble rows
  ("Meridian Commercial Bank", account number, currency, statement period)
  where only column A is populated. So row 0 becomes
  `["Meridian Commercial Bank", "", "", "", ""]`: one label plus several
  empty-string "headers".
- **Why the contract permits it:** nothing between the parser and the UI asserts
  that a header is a non-empty, unique, selectable identifier. The parser treats
  "first non-empty row" as the header row, and the UI treats every element of
  `headers` as a valid Select option value.

Secondary defect on the same line: duplicate header labels (also common in bank
exports, e.g. two blank-ish "Amount" columns) collide as Select values and as
`rawData` keys in `applyColumnMapping`, and `headers.indexOf(mapping.x)` then
resolves the wrong column silently.

## Business meaning of the Select

`MapField` is a **statement column-mapping** control: "which column in your file
is the Date / Description / Amount / Reference / Credit / Debit / Balance". It
is not a GL account, bank account or classification picker. Its values are
positions in the uploaded file, not domain entities.

"Not mapped" is a legitimate state for the optional fields, and it is already
modelled correctly — via the sentinel `"__none__"` item, translated back to `""`
in `onValueChange`. The bug is not the sentinel; it is that a *file column* with
a blank name is being offered as a selectable option.

## Architectural assessment

- **Not** an API/RPC or database contract problem. Ingestion is server-owned
  (`bank_statement_import_batch`, ADR-0143/0144) and is never reached — the crash
  is pre-import, before any row leaves the browser. No journal, no payment, no
  accounting state is involved.
- **Not** an "unassigned account" state-model problem: the reconciliation
  screens are downstream and are not on this code path. `bank_transactions`
  legitimately allows a null category and that stays untouched.
- It is a **parser normalization + UI contract** defect, at two layers:
  1. the parser emits a header list that is not a valid set of identifiers;
  2. the mapping UI assumes header strings are safe Select values.

## Repair

**Layer 1 — parser normalization (`src/lib/bankStatementParsers/csvParser.ts`)**

- Detect the header row instead of taking the first non-empty row: scan the
  first ~15 non-empty rows and choose the one with the most non-empty cells that
  also looks like labels (non-numeric, non-date), preferring a row followed by a
  row of comparable width. Rows above it become statement preamble/metadata.
- Emit a *column descriptor* list rather than raw strings: each column keeps its
  index, its raw label, and a stable non-empty `key`
  (`label` when unique and non-blank, otherwise `Column C` / `Label (2)`).
- Drop columns that are blank in the header **and** empty in every data row.
- Keep `rawRows` positionally aligned with the descriptors.

**Layer 2 — mapping UI (`ImportStatementWizardPage.tsx` / `MapField`)**

- Map over the descriptors; `SelectItem value` becomes the guaranteed-non-empty
  `key`, the visible text stays the human label plus a sample value.
- Keep the existing `"__none__"` sentinel for optional fields; keep the
  placeholder as the representation of "nothing selected". No `<SelectItem
  value="">` anywhere.

**Layer 3 — mapping application (`bankStatementParsers/index.ts`)**

- Resolve columns by descriptor key → index instead of `headers.indexOf(label)`,
  removing the duplicate-label mis-resolution. `rawData` keys use the stable key.

Types (`ParsedStatement.headers`) change shape, so every consumer of
`parseStatementFile` / `applyColumnMapping` is updated in the same change. No
`@ts-nocheck` is added; the existing one on the wizard page stays as-is.

## Regression risk

- Other consumers of `parseStatementFile` / `applyColumnMapping` — checked and
  updated together (import wizard is the primary; migration steps use their own
  `useMigrationFileUpload` path and are not touched).
- Header-row detection could pick the wrong row on an unusual layout. Mitigated
  by keeping the mapping step always user-editable and by showing a sample value
  under each column so a wrong guess is visible and correctable.
- OFX/QBO/QIF parsers produce transactions directly (`needsColumnMapping:
  false`) and are unaffected.

## Verification

- Unit tests over the parser: Meridian-style preamble statement, blank trailing
  columns, duplicate header labels, credit-only, debit-only, single-amount
  column, header row not at index 0. Assert every emitted column key is
  non-empty and unique.
- A component test asserting no rendered `SelectItem` in the mapping step has an
  empty value, for the Meridian fixture.
- Manual run in the preview: drop the Meridian statement, confirm the mapping
  step renders, columns map, preview lists the 05-Aug-2026 KES 1,670.40 credit
  for Fredrick Mureti / INV-00002, and import succeeds via
  `bank_statement_import_batch` only (no journal, no duplicate payment).
- Confirm the imported credit lands unreconciled/unclassified and the
  reconciliation page renders it without crashing; the Undeposited Funds
  settlement behaviour is left for the reconciliation work and is not touched
  here.

## Out of scope

No changes to reconciliation matching, journal posting, undeposited-funds
handling, journal numbering, or any RPC/migration. If verification shows the
reconciliation page itself also crashes on an unclassified row, that is reported
back as a separate finding rather than folded into this repair.
