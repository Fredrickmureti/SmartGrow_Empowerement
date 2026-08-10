# RFQ Document Architecture — Corrective Engineering Plan

## Verdict

**The attached PDF is not an acceptable RFQ.** It is an invoice-shaped commercial document with its title changed to “REQUEST FOR QUOTATION.” The visible `Bill To`, `Price`, `Tax`, `Amount`, `Total KES NaN`, and “Thank you for your business!” are all incompatible with a buyer solicitation.

The evidence also proves the prior implementation was not verified end-to-end:

- The live database now contains an RFQ-native v2 AST and the frozen `RFQ-0001` snapshot contains no price, tax, amount, subtotal, or total fields.
- The source tree contains an RFQ-specific `generateSolicitationPdf` route with requirement columns only.
- Nevertheless, the attached PDF created at 22:56 UTC still came from the generic priced-document renderer. Therefore source/database changes alone did not converge the actual delivery path.
- No `document_artifacts` row exists for this render, so the PDF is not a canonical archived artifact. The email helper still permits fallback to legacy `generate-document`, which can produce exactly this invoice-shaped output.

There are further confirmed architecture defects:

1. `document_records` is keyed only by source RFQ id, and `ensure_document_record` updates the existing snapshot in place. The current implementation therefore cannot keep Rev 1 and Rev 2 as distinct immutable records.
2. `rfq_revisions` stores historical sourcing snapshots, but the render path does not materialize documents from those revisions.
3. `purchases.rfq` is missing from the artifact persistence allowlist, so RFQ renders are not archived even when `render-document` succeeds.
4. The artifact supersession query uses `supersedes_id IS NULL` as if it meant “current”; inserted replacement artifacts set `supersedes_id` to the previous artifact, so retrieval/supersession semantics are internally inconsistent.
5. Invitation email delivery freezes one supplier-neutral record and calls `send-document-email`, which can silently continue without an attachment if PDF generation fails. It does not prove attachment identity or canonical-artifact success.
6. The generic renderer allows invalid numeric values to reach formatting. RFQ-native rendering removes the invalid total, but the shared numeric boundary still needs to reject non-finite values for every financial document.
7. Existing RFQ tests cover sourcing lifecycle boundaries, not RFQ document semantics, rendered bytes, revision stability, or delivery convergence.
8. The adjacent document check found Purchase Requisition has a separate internal-only kind/layout, while Purchase Order and Vendor Bill retain genuine priced-document contracts. Goods Receipt still has a legacy zero-priced generic fetcher and needs a targeted parity check rather than an assumed pass.

## Correct Business Contract

An RFQ is a **buyer solicitation**. Its supplier-facing snapshot will contain only canonical sourcing data supported by the RFQ model:

- RFQ number and revision
- issue/release date, response deadline, required-by date, status where appropriate
- originating requisition reference when present
- issuing legal entity/business and branch context
- buyer/procurement contact details available from canonical business/user data
- invited supplier identity/contact for supplier-addressed issued copies, or an explicitly supplier-neutral buyer copy
- item code, description, specification, quantity, UOM, line required-by date
- delivery destination derived from the selected warehouse/branch
- response instructions and supported commercial requirements/notes

It will never contain `target_price`, supplier quotation prices, tax, line amounts, subtotal, payable total, amount due, payment instructions, or invoice gratitude copy. `target_price` remains an internal procurement estimate used by the buyer interface and scoring only.

## Implementation Phases

### 1. Make RFQ document identity revision-native

- Change RFQ document materialization so the identity includes RFQ revision, rather than mutating one current record per RFQ source id.
- Preserve issued revisions as immutable `document_records`; link later revisions through the existing supersession fields without rewriting historical snapshots.
- Materialize supplier-addressed issued copies from the invitation/revision identity where the artifact must show an invited supplier; keep an intentional supplier-neutral buyer copy separate.
- Build historical copies from `rfq_revisions.snapshot` and current copies from canonical RFQ state.
- Keep tenant/business access and existing lifecycle RPC governance; do not add a document-specific permission engine.

### 2. Enforce one RFQ-native snapshot contract

- Create one shared, validated RFQ snapshot contract used by both the TypeScript preview/print builder and the SQL/outbox materializer.
- Add requisition number/reference, buyer contact, supplier, destination, branch/business identity, requirements, dates, and response instructions only where canonical data exists.
- Explicitly reject forbidden monetary keys, including nested item keys, before an RFQ snapshot can be frozen or rendered.
- Preserve `target_price` internally but prove it is absent from every supplier-facing snapshot.

### 3. Make the canonical renderer the only RFQ renderer

- Keep RFQ inside the existing rendering engine and shared `PdfBuilder`; do not create a new engine.
- Make the RFQ template/layout dispatch contract explicit and fail closed if an RFQ resolves an invoice preset, bill-to party role, totals block, or generic priced-document renderer.
- Remove RFQ eligibility for `generate-document` fallback. If canonical materialization/rendering fails, preview/email/download must fail visibly rather than send an invoice-shaped or attachment-less substitute.
- Extend the AST type vocabulary for the already-seeded RFQ/requisition presets so database AST, TypeScript types, and renderer behavior agree.

### 4. Correct artifact persistence and selection

- Add `purchases.rfq` and `purchases.requisition` to the canonical artifact persistence policy with the appropriate audit behavior.
- Key artifact selection by document record/revision, medium, paper/profile, and resolved template version; never return an artifact rendered under a superseded template for the current issued copy.
- Correct current/superseded artifact selection semantics and use one authoritative rule in persistence, preview, print, download, and email.
- Do not overwrite or relabel the bad historical PDF; generate a new corrected artifact with explicit regeneration provenance where remediation is required.

### 5. Converge preview, print, download, and supplier email

- Preview renders/selects the canonical revision artifact without opening a print job.
- Print queues the same document record/artifact through `PrintService` and the existing print ledger.
- Download uses the real download disposition and the same canonical bytes, never browser “Print → Save as PDF.”
- RFQ release first freezes the issued revision, obtains a valid canonical artifact, then sends that exact artifact through the existing email engine.
- Record the artifact/document-record identity against each invitation/email audit so a supplier delivery is traceable to RFQ revision and content hash.
- Treat failure to create/attach the canonical issued RFQ as delivery failure; do not silently send text-only release mail.

### 6. Harden invalid numeric rendering globally

- Add a shared finite-number assertion/normalizer at the renderer contract boundary and numeric components.
- Financial documents with required amounts must fail with a diagnostic when values are non-finite; optional numeric cells render as absent only when the contract permits absence.
- Never coerce `NaN` to zero. RFQ avoids the field because it is semantically invalid; genuine financial documents surface malformed data for correction.

### 7. Add regression guards

Add focused tests for:

- RFQ AST rejects `line_items`, `billTo`, invoice totals, amount due, payment blocks, and invoice footer language.
- RFQ TS and SQL snapshots have equal canonical shape and contain no `target_price` or monetary line/total keys.
- Rendered RFQ text contains the supported solicitation fields and contains none of `Bill To`, price/tax/amount totals, `NaN`, `undefined`, `null`, or “Thank you for your business.”
- Rev 1 and Rev 2 create distinct immutable records and byte artifacts; re-rendering Rev 1 reproduces Rev 1.
- Preview, print, download, and email resolve the same document record, template version, and content hash.
- Requisition remains internal-only and cannot acquire an external email intent.
- PO and Vendor Bill retain priced contracts; GRN’s legacy zero-price path is either proven unreachable or converged to its quantity-receipt contract without redesigning healthy documents.
- Generic numeric rendering rejects non-finite values.

## Verification and Evidence Required Before Completion

1. Run focused snapshot, rendering, procurement, printing, email, and revision tests.
2. Generate a representative issued RFQ with supplier, deadline, requisition origin, UOM, specification, destination, and required-by data.
3. Exercise preview, real file download, print dispatch, and supplier email.
4. Compare hashes/artifact ids across all four dispositions.
5. Render the final PDF to page images and inspect every page for clipping, overlap, spacing, and missing data.
6. Extract text and assert all forbidden invoice semantics and invalid placeholders are absent.
7. Generate Rev 2, then retrieve Rev 1 again and prove its bytes/content remain unchanged.
8. Inspect representative Requisition, PO, GRN, and Vendor Bill artifacts for title/body contract parity.

Completion will be reported only with the inspected artifact, content hash evidence, revision evidence, and test results—not from compilation or template existence alone.
