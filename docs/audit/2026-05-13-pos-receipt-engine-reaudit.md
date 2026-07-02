# POS Thermal Receipt Engine — Stage R0 Re-Audit

Date: 2026-05-13
Scope: independent zero-trust verification of the ESC/POS receipt path. No code changes.

## Verdict

The current ESC/POS engine is **substantially configuration-driven**, not the "hardcoded" engine the user feared. The `Paper:Width80mm Font:FontA Align:Left CP:19` line you observed is an **ESC/POS byte-decoder annotation** (`1B 61 00` → `Align:Left`, `1B 74 13` → `CP:19` = CP858), not text the printer ever prints. It comes from a debug tool decoding the byte stream, not from the receipt body.

The previous agent's R1 / R1.5 / R2a claims are real. The architectural gaps that remain are around (a) capability negotiation (PrinterProfile), (b) fiscal abstraction, (c) raster logo, (d) section-order configurability, (e) locale + codepage, and (f) a width-honest preview surface. All listed in the redesign roadmap.

## 1. Settings → ESC/POS wiring (verified)

| Stage | File:line | Evidence |
|---|---|---|
| Snapshot writer | `supabase/migrations/20260511083215_*.sql:73-123` | SQL function `_pos_build_receipt_snapshot` builds JSON with `schema_version: 1`, `transaction`, `items`, `payments`, `business`, `branch`, `organization`, `customer`, `cashier`, `register`, **`business_receipt_settings`**, **`register_receipt_settings`**. |
| Snapshot trigger | `…:155-160` | `CONSTRAINT TRIGGER trg_pos_write_receipt_snapshot AFTER INSERT ON pos_transactions DEFERRABLE INITIALLY DEFERRED`. |
| Edge fn — snapshot read | `supabase/functions/generate-document/index.ts:497-501` | `pos_receipt_snapshots.payload` is the first source. |
| Edge fn — merge | `…:525-529` | `mergeReceiptSettings(business_receipt_settings, register_receipt_settings)` from shared Deno mirror. |
| Edge fn — settings attached | `…:563, 714` | `pos_receipt_settings: mergedSettings` rides on `DocumentData`. |
| Edge fn — escpos branch | `…:1429-1438` | `buildDocumentEscPos(documentData, { receiptSettings: documentData.pos_receipt_settings })`. |
| Builder honors settings | `supabase/functions/_shared/escpos/builder.ts` | paper width (170-181, 253-257), line spacing (443-444), font_size + large accent (446-452), per-section align (455-457, 593, 663, 690), header (459-487), title + meta (491-516), customer (519-532), three item layouts (573-683), totals + tax buckets + savings (688-751), payments + tendered + change (753-781), notes/terms/footer/return policy (784-813), eTIMS info+QR (815-829), generic barcode + QR (831-842), copies + cut policy (844-881). |
| Currency formatter | `…:347-378` | `currency_display`, `currency_position`, `currency_symbol_override`, `decimal_places`, `thousands_separator` all honored. |
| Date/time formatter | `…:380-436` | IANA timezone via `Intl.DateTimeFormat` resolved from `org.timezone`; `date_format` and `time_format` honored. |
| Whitelist (12 fields) | `src/hooks/pos/useMergedReceiptSettings.ts` + `supabase/functions/_shared/pos/mergeReceiptSettings.ts` | Both copies kept in lockstep. |

### Settings-coverage matrix

| Field | Client preview | ESC/POS | PDF | Customer display |
|---|---|---|---|---|
| paper_size | y | y | n/a | n/a |
| font_size | y | y | n/a | n/a |
| line_spacing | y | y | n/a | n/a |
| receipt_header / receipt_footer | y | y | y | n |
| show_store_* (name/address/phone/email) | y | y | y | partial |
| show_receipt_number / show_date_time | y | y | y | y |
| show_cashier_name + cashier_label_format | y | y | y | n |
| show_register_id | n | y | n | n |
| show_customer_name | y | y | y | n |
| show_item_sku / quantity / unit_price / discount | y | y | y | n |
| truncate_long_names + max_item_name_length | y | y | n/a | n |
| item_display_format (single-line / two-lines / tabular) | y | y | n/a | n |
| show_subtotal / show_discount_total / show_tax_breakdown / show_tax_rate / show_savings | y | y | y | n |
| show_payment_method / show_amount_tendered / show_change_due | y | y | y | n |
| show_return_policy + return_policy_text | y | y | y | n |
| show_barcode | partial | y | n | n |
| show_qr_code | partial | y | n | n |
| show_etims_info / show_etims_qr | y | y | y | n |
| header/meta/items_header/totals/footer alignment | partial | y | n | n |
| currency_display / position / override / decimal_places / thousands_separator | partial | y | partial | n |
| date_format / time_format + IANA tz | y | y | y | partial |
| show_item_modifiers / show_refund_banner | y | y | n | n |
| copies / copy_labels / cut_mode / feed_lines_after | n | y | n | n |
| auto_print_receipt | client only | n/a | n/a | n/a |
| show_logo | y | **NO** | y | n |
| section_order | n | **NO** | n | n |
| language / secondary_language | n | **NO** | n | n |
| printer profile / capabilities | n | **NO** | n/a | n |

## 2. Confirmed gaps (drive the redesign)

1. **Dual receipt models.** `ReceiptDocumentModel` (client preview, customer display) and `DocumentData` (PDF + ESC/POS) are independently derived. `printThermal(model, …)` in `src/lib/pos/receipt/renderers/ThermalPrintRenderer.ts:29-44` only uses `model.meta.transaction_id` — the bytes come from a fresh edge-fn fetch. Preview vs printed receipt can drift in the snapshot-write race window (deferred trigger).
2. **Raster logo not emitted** in ESC/POS path. `show_logo` is a no-op for thermal.
3. **Fiscal block is jurisdiction-coupled.** `builder.ts:815-829` reads `etims_cu_number` / `etims_qr_data` directly. No abstraction for ZATCA, eFRIS, AFIP, NFC-e.
4. **No section-order config.** Order is hardcoded.
5. **Codepage fixed at CP858.** Builder always emits `ESC t 19`. Arabic / Cyrillic / Thai / CJK customers cannot be served correctly.
6. **No PrinterProfile / capability handshake.** Builder always emits `GS V 0` full-cut, fixed `ESC d` feed, fixed line-spacing dot values, fixed drawer pin via the printer service. Unsupported features cannot be downgraded gracefully.
7. **No "Print Test Page" UX.** Cashiers must ring up a fake sale to validate settings.
8. **Width-honest preview missing.** `PreviewRenderer.tsx` uses CSS, not character-grid math; preview alignment can differ from print.
9. **Tabular on 58mm + show_item_sku** (mathematically infeasible) is soft-wrapped silently rather than downgraded with a one-line note.

## 3. Refuted concerns

- ❌ "Renderer is hardcoded." The builder reads 35+ fields from merged settings.
- ❌ "Settings are ignored." Snapshot path attaches them; live fallback re-merges; builder honors them.
- ❌ "Receipt prints `Paper:Width80mm Font:FontA Align:Left CP:19`." That is decoder annotation, not receipt content.
- ❌ "No barcode/QR support." Both are emitted (`builder.ts:831-842`) via `pushCode128` and `pushQrCode`.
- ❌ "No cut/copies control." Implemented (`builder.ts:844-881`) with `cut_mode`, `copies`, `copy_labels`, `feed_lines_after`.
- ❌ "Snapshot doesn't store settings." Migration `20260511083215_*.sql:120-121` proves both keys are persisted.

## 4. Source-of-truth files (single index)

- Server builder: `supabase/functions/_shared/escpos/builder.ts`
- Edge dispatcher: `supabase/functions/generate-document/index.ts`
- Snapshot writer: `supabase/migrations/20260511083215_d198280f-736a-47dd-a24e-6d4b7064db06.sql`
- Settings whitelist (Deno): `supabase/functions/_shared/pos/mergeReceiptSettings.ts`
- Settings whitelist (client): `src/hooks/pos/useMergedReceiptSettings.ts`
- Client renderer wrapper: `src/lib/pos/receipt/renderers/ThermalPrintRenderer.ts`
- Client preview: `src/lib/pos/receipt/renderers/PreviewRenderer.tsx`
- ESC/POS bytes call site: `src/services/printing/pdfUtils.ts::generateDocumentEscPosBytes`
- Architecture lock-in: `src/test/architecture/pos-receipt-renderer-contract.test.ts`
- Snapshot read guard: `src/test/pos/stage-b-receipt-snapshot.test.ts`
- Default fields + types: `src/types/receipt.ts`, `src/lib/receiptConfig.ts`

Stage R0 complete. Next: Stage R1.6 (Test Print) — synthetic `pos_receipt_preview` document type behind a server guard, plus a "Send test print" button in `ReceiptSettings.tsx` and `POSSettings.tsx`.
---

## Stage R1.6 verdict — Test Print shipped (2026-05-13)

- Synthetic `pos_receipt_preview` document type added to `supabase/functions/generate-document/index.ts` (early branch, before fetcher dispatch). Builds `DocumentData` from request body only; never reads or writes `pos_transactions`.
- Server guards: rejects `format != "escpos"` (400), rejects UUID-shaped `documentId` (400), only accepts the literal sentinel `"test-print"`. Reuses the canonical `buildDocumentEscPos` so test-print bytes are byte-equivalent to a real sale at the same settings.
- New client hook `src/hooks/pos/useTestPrintReceipt.ts` invokes the function, then either streams bytes via `printRawBytes` (when a hardware proxy is supplied) or downloads `.bin` for inspection.
- "Send Test Print" buttons added to `src/components/settings/ReceiptSettings.tsx` (company defaults) and `src/pages/pos/POSSettings.tsx` (POS overrides — sends merged company + override settings).
- Static contract test: `src/test/pos/stage-r1-6-test-print.test.ts` — 6 assertions (recognition, FETCHER_MAP/TABLE_MAP exclusion, UUID rejection, format gate, shared builder reuse). All pass.

Next: Stage R2a (snapshot-shape contract).
