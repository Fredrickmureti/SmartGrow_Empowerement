# Scanning capability: audit findings and reconstruction

## What I verified in the code (not assumed)

**The crash is a half-finished rename, not a missing feature.**
`src/components/documents/lines/DocumentLineScanner.tsx` exists, but line 70
still declares `export function InvoiceLineScanner(...)`. It is the only export
in the file. Eleven Sales pages import `{ DocumentLineScanner }` from that path.
So every one of those forms fails at module load — Estimates, Sales Orders,
Delivery Notes, Credit Notes, Proforma, Returns, and both Invoice pages.

The previous agent did move the component from
`src/components/invoices/InvoiceLineScanner.tsx` to the generic path, created a
genuinely shared `useDocumentLineScan` hook, and wired all eleven forms. The one
step it missed was renaming the exported symbol. Its guard test
(`src/test/architecture/sales-document-scanner-parity.test.ts`) only reads files
as **text** and regex-matches `<DocumentLineScanner`, so it passed while the app
was unloadable. That is the architectural condition that let this ship.

**Sales coverage is actually good.** All eleven line-capturing Sales forms use
the same pipeline: `SalesScanProvider` (mounted in `SalesLayout`) owns one
long-lived router target; `DocumentLineScanner` registers a controller;
`useDocumentLineScan` + `applyScanToLines` turn a `ResolvedScan` into lines with
document-appropriate semantics (`capture` for authoring docs, `verify` for
delivery notes with over-delivery refusal). Business logic stays in the host form.

**Purchases has zero scanning.** `rg` across `src/features/purchases` and
`src/apps/purchases` finds no `BarcodeInputField`, no `useScanTarget`, no
`applyScanToLines`, no provider. Purchase Orders, RFQs, Requisitions, Vendor
Bills and Purchase Returns all capture product lines with no scan path.
Goods Receipt is the exception: it redirects into the Warehouse receiving
workspace, which has its own sanctioned WMS scan stack (entity-typed intents per
ADR 0120) — correct as-is, not to be duplicated.

**The input layer is already device-agnostic.** Camera, paired phone, USB/HID
wedge and native handheld SDKs all converge on `scanBus → scanRouter →
useResolveBarcode`. Nothing is coupled to the camera UI. The gap is coverage of
document surfaces, not transport architecture.

So: your suspicion is half right. Scanning *is* a reusable capability and Sales
was correctly propagated — but the propagation shipped broken, and Purchases was
never touched.

## Plan

### 1. Fix the root cause
Rename the component to `DocumentLineScanner` in its own file, update its
header docs, and keep a deprecated `InvoiceLineScanner` alias only if something
still needs it (nothing does — verified by grep, so no alias).

### 2. Make the guard real
The parity test greps text. Replace the file-text assertions with an actual
`import` of the module plus an export-name assertion, and add a repo-wide check
that every `@/components/**` import specifier resolves to a real export for the
scanner modules. A text-only guard cannot catch this class of bug again.

### 3. Generalise the provider so Purchases can reuse it
`SalesScanContext` is workspace-scoped, not domain-specific in substance. Extract
its mechanics into a `DocumentScanProvider` (same buffering, same controller
registration, same rapid/browse mode, storage key parameterised by workspace).
`SalesScanProvider` becomes a thin wrapper over it so Sales behaviour and its
existing tests are unchanged. `PurchasesLayout` mounts the same provider.

### 4. Add scanning to Purchases documents
Classification, and what each gets:

| Document | Class | Action |
|---|---|---|
| Purchase Order (create/edit) | Useful | `DocumentLineScanner`, capture mode |
| RFQ (create/edit) | Useful | capture mode |
| Requisition (create) | Useful | capture mode |
| Vendor Bill (create/edit) | Useful | capture mode |
| Purchase Return (create/edit) | Strongly expected (physical goods) | verify-style: scan ticks off returnable lines, over-return refused |
| Goods Receipt | Strongly expected | already covered by Warehouse receiving — documented exclusion, no change |
| Expenses, Price Lists, Contracts, Statements | Not applicable | no product-line capture; documented |

Each page reuses `useDocumentLineScan` with its own `matchLine`/`buildLine`/
`applyToExisting` — vendor pricing, tax, currency and document lifecycle stay in
the existing form logic. The scanner never writes to the database.

### 5. Extend the parity guard to Purchases
Same guard, second document list, so a new purchasing document cannot ship
without a scan decision.

### 6. Verify by running the flows
Playwright against the running app: open each Sales and Purchases create/edit
form, confirm it mounts with no runtime error, the scanner control renders, a
simulated wedge scan resolves and lands the right line, a repeat scan follows
the document's rule, an unknown code surfaces the refusal, and manual product
selection still works. Plus the existing scanner/architecture vitest suites.

## Deliverable
An audit write-up with root cause, previous-claim-vs-actual table, the full
coverage matrix, the final architecture diagram, files changed, and the
verification evidence.

## Out of scope
Renaming the `pos_resolve_barcode` RPC, the POS terminal cart consumer, and the
warehouse WMS scan stack.
