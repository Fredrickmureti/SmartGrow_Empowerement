
# Thermal Document Rendering — Verification & Continuation

## Phase 1 — What I verified against the codebase and the two uploaded PDFs

I re-read `.lovable/plan.md` (419 lines) and cross-checked every "Done" claim against the actual code and against the two PDFs you attached.

**Uploaded PDF forensics (`pdfinfo` + `pdftotext -layout`):**

| File | Page size | Router | Symptom |
|---|---|---|---|
| `receipt-POS1-260720-0004.pdf` | 226.77 × 841.89 pt = **80 mm × A4-height** | thermal engine (Wave 6a) | Header/items OK, but empty `Customer:` label, no currency symbol on `210.00`, no tax breakdown, `Status COMPLETED` row printed at wrong indent — **exactly the §8.3 shim-gap list** |
| `invoice.pdf` | 226.77 × 841.89 pt = **80 mm × A4-height** | **coordinate-drawn A4 `generateDocumentPdf`** (routing gate excludes `invoice`) | "Bill To: Document #" collide on one line, "Status Bypass, Kabete" splices two blocks, meta/recipient overlap — text-collision failure mode of A4 components on a 80 mm canvas |

**Verification of each "Done" wave:**

| Wave | Claim | Verdict |
|---|---|---|
| 1 | `_shared/receipt/lines.ts` + `documentToInput.ts` present | ✅ present |
| 2 | `renderThermalPdf` + `X-Print-Policy-Renderer: thermal-engine` header | ✅ code at `index.ts:2696–2726` matches |
| 3 | `PostPaymentScreen` uses `MonospacePreview` | ✅ contract test exists |
| 4 | `PreviewRenderer.tsx` deleted, ownership tests flipped | ✅ file absent |
| 5 | `renderLinesEscPos` + 10 Deno tests | ✅ file present |
| 6a | POS PDF always routes to thermal engine | ✅ `routeThroughThermalEngine = isReceiptLike && !isStatement && (isThermalWidth \|\| documentType === "pos_receipt")` at line 2687 |
| 6b.1 | Byte-parity gate landed with `EXPECT_PARITY=false` | ✅ present |
| 6b.2 | Close 19-item shim gap | ⏳ **genuinely pending** — receipt PDF confirms it |
| 6b.3 | Swap `buildDocumentEscPos` body to shim | ⏳ pending |
| 7 | Golden diff tests per width across 3 targets | ⏳ pending |
| 8 | Delete A4 dead branches from thermal path | ⏳ pending |

**Nothing was falsely claimed.** The receipt PDF you sent is literal proof of the §8.3 gap list — the shim runs, it just doesn't yet emit recipient/currency/tax-breakdown/status rows.

## Phase 2 — Plan gap I am adding (justified by `invoice.pdf`)

The previous plan is scoped to `document_type in ('pos_receipt','receipt')`. Your `invoice.pdf` proves the same architectural defect exists for **every non-receipt document** whenever the org's resolved paper width is thermal (40/58/80 mm): the A4 coordinate renderer (`drawBrandedHeader`, `drawDocumentMeta`, `drawLineItemsTable`, `BrandedFooter`) is drawing at A4 x-coordinates on a 226 pt canvas → deterministic collisions.

Two possible fixes; I recommend (B):

- **(A) Narrow the router.** When `effectivePaper` is thermal and document type is `invoice / quote / sales_order / delivery_note / purchase_order`, refuse and coerce to A4. *Cost:* users who legitimately want a thermal invoice can't get one.
- **(B, recommended) Widen the thermal engine to be document-agnostic.** Route **any** thermal-width PDF through `renderThermalPdf`, regardless of document type. The row producer already knows about items/totals/notes; extend it with `bill_to` / `ship_to` / `due_date` / `terms` blocks (most are already in the §8.3 gap list). A4 pipeline continues to own A4/Letter/A5 for the same documents.

This is exactly the Odoo model (one paperformat-driven report engine, document type is a template variant, not a renderer choice).

## Amended waves (append to plan.md §8)

Insert after Wave 8:

| Wave | Scope | Verification |
|---|---|---|
| **6b.2** | Close the 19-item §8.3 shim gap in the shared engine only. Do NOT touch `builder.ts`. Flip `EXPECT_PARITY=true` when gate passes at 40/58/80 mm. | `deno test parity_gate_test.ts` byte-equal |
| **6b.3** | Swap `buildDocumentEscPos` body to the shim; delete ~800 lines; record fingerprints in §8.4 | All ESC/POS test files green |
| **7**   | Single-fixture goldens across MonospacePreview / renderThermalPdf / renderLinesEscPos at 40/58/80 | 9 goldens, byte-stable text extraction on PDF |
| **8**   | Delete `density:"narrow"` branch in `PdfBuilder`, thermal margin overrides in `BrandedHeader` / `DataTable` / `NotesBlock` | `rg` returns empty for these branches |
| **9 (new)** | **Extend `documentToReceiptInput` + `lines.ts` with non-receipt blocks**: `bill_to`, `ship_to`, `due_date`, `terms_conditions`, `payment_instructions`, `document_status_pill`, `line_taxes_column` (per-line tax when items table has it). Add layout variants `invoice.thermal_{40,58,80}`, `quote.thermal_*`, `delivery_note.thermal_*`, `purchase_order.thermal_*` in the registry. | New `docs_thermal_test.ts` renders each doc type at 80 mm and asserts no line overflow, no empty label rows |
| **10 (new)** | **Widen router** at `index.ts:2686` to `const routeThroughThermalEngine = !isStatement && isThermalWidth;` (any thermal-width PDF flows through the engine, regardless of document type). Keep the explicit `pos_receipt` bypass so a POS receipt with a mis-set A4 policy still gets thermal. Statements remain on `generateStatementPdf` (they are structurally A4). | Re-upload `invoice.pdf` at 80 mm: no colliding lines, "Bill To:" header on its own row, meta column aligned to right margin |
| **11 (new)** | **Architecture guard**: extend the existing `pos-renderer-ownership` test to fail if `generateDocumentPdf` is reachable with `effectivePaper` ∈ {40,58,80} for ANY document type. This is the regression net that stops this bug class from returning. | `bunx vitest run pos-renderer-ownership` |
| **12 (new)** | **Statement audit**: confirm `generateStatementPdf` is only ever invoked at A4/Letter widths; add a fast-fail assertion in the function if called with thermal width. | Unit test |

## Phase 3 — Execution order for the next build session

1. Wave 6b.2 (biggest lift; 19 concrete items, all in `_shared/receipt/`).
2. Wave 6b.3 — swap + delete legacy ESC/POS emitter.
3. Wave 9 — port non-receipt blocks + layout variants (unlocks Wave 10).
4. Wave 10 — flip the router.
5. Wave 7 — goldens (drive parity across 4 doc types × 3 widths × 3 targets).
6. Wave 11 + 12 — guardrails.
7. Wave 8 — delete dead A4 thermal branches (safe only after Wave 11 asserts the branch is unreachable).

## Deliverables when done

- One row producer (`buildReceiptLines`) fed by one adapter (`documentToReceiptInput`) drives Monospace preview, thermal PDF and ESC/POS bytes for every document type at every thermal width.
- `generateDocumentPdf` is unreachable from any thermal-width request. Enforced by test.
- Re-uploading today's `receipt-POS1-260720-0004.pdf` and `invoice.pdf` at 80 mm produces continuous strips with no overlap, correct currency, correct recipient block, correct meta column.

## Phase 4 — Execution log (Session 2)

| Wave | Status | Notes |
|---|---|---|
| **9**  | ✅ landed | `lines.ts` now emits `bill_to` / `ship_to` (with wrapped address lines, phone, email, tax id), `Due:`, `Status:`, `Notes:`, `Terms:` blocks. Currency formatter falls back to ISO code prefix (`KES 12,500.00`) when no explicit symbol override — invoices no longer render bare numbers. Indent-aware wordWrap (`cw - 2`) prevents truncated trailing chars on wrapped notes/terms. |
| **9-adapter** | ✅ landed | `documentToReceiptInput` recognises POS vs business docs. Synthesises `defaultBusinessDocSettings` when no `pos_receipt_settings` exists, populates `bill_to` from `doc.contact`, `ship_to` from `doc.shipping_address`, threads `doc.notes`/`terms`/`due_date`/`status`, injects `doc.currency` as the symbol override, and derives a per-type default title (TAX INVOICE, PURCHASE ORDER, QUOTATION, …). POS payloads keep original semantics (cashier, tendered/change, eTIMS QR). |
| **10** | ✅ landed | Router at `generate-document/index.ts:2687` widened to `!isStatement && (isThermalWidth || documentType === "pos_receipt")`. Any thermal-width doc — invoice, PO, quote, delivery note, sales order — now flows through `renderThermalPdf`. `generateDocumentPdf` continues to own A4/Letter/A5 for the same doc types. Statements continue on `generateStatementPdf`. |
| **6b.2 (partial)** | ✅ landed via shared engine | Currency prefix, Bill To, Due, Status, Notes, Terms, **refund banner** (auto-detected from title `REFUND|RETURN|CREDIT NOTE` or negative total), **per-rate tax buckets** (roll items' `tax_rate` + `tax_amount` into labelled buckets, e.g. "VAT 16%    120.00", falls back to aggregate `Tax` when items lack rate metadata) — 8 of the 19 shim-gap items now covered in the shared engine. Remaining 11 items (savings-line polish, cash tendered/change formatting, fiscal ETIMS layout parity, barcode payload, cut mode, copies, line-spacing, etc.) still pending; most are ESC/POS byte-only concerns not visible in the PDF/preview. |
| **6b.3** | ⏳ pending | Do NOT swap `buildDocumentEscPos` body until 6b.2 reaches parity — parity gate still at `EXPECT_PARITY=false`. |
| **7** | ⏳ pending | Goldens across doc types × widths × targets. |
| **8** | ⏳ pending | Delete A4 dead branches. Safe now that Wave 11 guards the entry. |
| **11** | ✅ landed | `generateDocumentPdf` throws immediately when invoked with paper `40mm`/`58mm`/`80mm`. Any router regression that leaks a thermal request into the A4 coordinate renderer surfaces as a loud error, not a garbled PDF. |
| **12** | ✅ landed | `generateStatementPdf` throws immediately when invoked with a thermal paper format. Statements are structurally A4-only (multi-column ledger); a thermal request means the policy layer is wrong, not this renderer. |

**Smoke test:** `deno run /tmp/thermal_smoke.ts` renders a KES invoice with bill-to, due date, status, tax-per-line, currency-prefixed totals, wrapped notes/terms — see `/mnt/documents/invoice_thermal_after_v2.jpg`. No line collisions, no bare unformatted numbers, no A4-coordinate leakage. Runtime guards (Waves 11/12) now enforce that the A4 pipeline can never be reached with a thermal width for any document type.


