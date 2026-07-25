# ADR-0098 — CSV export ownership (single writer per side)

- Status: Accepted (2026-07-25)
- Related: ADR-0085 (rendering ownership)

## Context

Client-side CSV exports across the ERP (Payroll, Contacts, Invoices,
Stock Movements, Audit Logs, Customer Ledger, migration templates, and
more) were each hand-rolling `new Blob([rows.join("\n")], { type:
"text/csv" })`. None of them prepended a UTF-8 Byte Order Mark, and all
used `\n` instead of CRLF. Excel on Windows opens a `.csv` without a
BOM in the system ANSI codepage (CP1252, CP936, …), so any non-ASCII
byte — accented names, currency symbols (€, KES), Arabic/Swahili, CJK
locales, em-dashes from formatters — was mis-decoded and surfaced to
operators as "Chinese"/gibberish.

Server-side (`supabase/functions/_shared/exports/reportCsv.ts`,
`statementCsv.ts`) already emits BOM + CRLF + RFC 4180. The defect was
strictly the divergence between server and client.

## Decision

CSV byte ownership is fixed by side:

| Side   | Sole owner                                              |
|--------|---------------------------------------------------------|
| Client | `src/lib/exports/csv.ts` (`buildCsv`, `csvBlob`, `downloadCsv`) |
| Server | `supabase/functions/_shared/exports/*` (`reportCsv.ts`, `statementCsv.ts`) |

Both sides MUST emit:

- UTF-8 with a leading Byte Order Mark (`\uFEFF`, i.e. `EF BB BF`),
- CRLF (`\r\n`) row separators including a terminal CRLF,
- RFC 4180 quoting: quote any cell containing `"`, `,`, `;`, `\r`,
  `\n`, or leading/trailing whitespace; escape `"` as `""`.

Application code MUST NOT construct `text/csv` Blobs directly, hand-roll
`join(",") + "\n"`, or otherwise author CSV bytes. Every download flows
through the canonical writer for its side.

## Consequences

**Positive**

- One place to fix encoding, quoting, delimiter or line-ending issues.
- Client and server CSVs are byte-shape identical, so an artifact
  downloaded from the browser and one persisted by an Edge Function
  round-trip through the same importers.
- No user-visible UX change: same button, same filename, same columns —
  only the bytes on disk change.

**Negative / accepted costs**

- New downloads must import from `@/lib/exports/csv` instead of
  constructing a Blob inline. This is enforced, not stylistic.

## Guardrails

- `src/__tests__/architecture.csv-single-writer.test.ts` — scans `src/`
  for `new Blob(..., { type: "text/csv..." })` outside the canonical
  writer and fails the suite on any offender. Allowlist:
  `src/lib/exports/csv.ts` (author) and
  `src/services/printing/PrintClient.ts` (transport pass-through to the
  server-side print router; never surfaces to a spreadsheet app).
- `src/lib/exports/csv.test.ts` — asserts BOM prefix, CRLF row
  separators, RFC 4180 quoting, non-ASCII round-trip (é, ñ, €, 中文, ش),
  null/undefined → empty, custom delimiter, and BOM-idempotent
  normalisation.
- Server-side tests `reportCsv_test.ts` and `statementCsv_test.ts`
  cover the equivalent invariants for `_shared/exports/*`.

## Exemptions

- `src/services/printing/PrintClient.ts` may wrap CSV bytes in a Blob
  strictly to upload to the print router; those bytes are authored by
  the caller (server or `buildCsv`) and pass through unchanged.
- Test fixtures under `src/test/**` and `*_test.ts` may embed CSV
  literals for assertion purposes.
