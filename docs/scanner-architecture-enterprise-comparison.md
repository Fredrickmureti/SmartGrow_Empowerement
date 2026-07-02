# Scanner Architecture — Enterprise Comparison

Last reviewed: 2026-05-18 (post-re-audit).

This document captures how our phone-as-scanner / barcode-injection
infrastructure compares to the major enterprise POS and ERP players, so
future work has an explicit baseline instead of "Odoo probably does it
differently."

## 1. Our model (verified)

| Layer | Component | Notes |
|---|---|---|
| Transport | Supabase Realtime, two topic families | `pos:scan:<register_id>` (POS) and `scan:session:<session_id>` (generic onboarding) |
| Auth | `private: true` channel + RLS on `realtime.messages` | Topic-scoped via `can_access_pos_scan_channel` / `can_access_scan_channel`; gates on SELECT (USING) **and** INSERT (WITH CHECK) |
| Pairing | One-shot tokens minted via `extensions.gen_random_bytes(24)` | 60-second expiry; auto-revoked on dialog close/unmount if no device claimed |
| Phone-side decoder | Native `BarcodeDetector` with ZXing fallback | Wake-lock + torch toggle + tab-visibility pause |
| Dedupe | 3 layers | (a) 400 ms local rebroadcast guard on the phone, (b) per-device monotonic `seq` on the terminal, (c) 250 ms cross-source dedupe in `scanBus` (with per-target `allowRepeats` opt-out for counting / receiving) |
| Routing | Global `scanBus` → `scanRouter` (priority stack) → focused `<BarcodeInputField>` via `useScanTarget` | Page-level fallback target at priority 5 lets `/products` resolve unknown scans even when no field is focused |
| Uniqueness | `product_identifiers (business_id, code_norm, kind)` plain unique constraint via generated stored column | Makes `INSERT ... ON CONFLICT` (PostgREST `upsert`) work; expression-index variant 42P10'd silently |
| Architecture guards | Vitest grep against migration history | `pgcrypto-extension-prefix.test.ts`, `realtime-scan-channel-policies.test.ts`, `pos-single-scanner.test.ts` |

Single global scan kernel is mounted **exactly once** in
`AuthenticatedShell` (`useScanCapture({ enabled: true })`) — a fact that
is pinned by `pos-single-scanner.test.ts`. Every other scan-aware surface
attaches into `scanRouter` rather than spawning its own kernel.

## 2. Odoo POS / Inventory

- IoT Box is the official path for hardware scanners. Phone-as-scanner is
  not first-class; the community modules that exist are timing-sensitive
  keyboard wedges.
- Owl `barcode_service` is a singleton that dispatches to handlers, very
  similar to our `scanRouter`. We diverge in that ours is focus-aware out
  of the box — Odoo's barcode actions are mostly model-keyed (one handler
  per record type) rather than field-keyed.
- Inventory has explicit scan-to-create and "barcode nomenclature"
  parsing (weighted barcodes, prefix-based product lookup). We have
  weighted parsing in `parseBarcode.ts` but no per-tenant nomenclature
  configurator yet — flagged as a future-wave item.
- Where we exceed: no IoT Box prerequisite, no Owl coupling, RLS-gated
  multi-tenant private channels, idempotent POS transactions.
- Where we lag: label-printing pipeline, multi-prefix barcode
  nomenclatures, lot/serial capture at the same fluency as Odoo
  Inventory.

## 3. Shopify POS

- Bluetooth / camera scanner integrates via the iOS / Android POS app
  only. Web POS is not a first-class surface.
- All scans land in the cart; there is no public "phone scans a barcode
  on a desktop product editor" workflow.
- We match feature parity inside the POS cart and exceed it on the
  inventory / onboarding side because our `<BarcodeInputField>` is
  reusable in any form (product create, purchase receive, count,
  transfer).
- Worth borrowing: Shopify's per-store scanner sound profiles. We have a
  similar `SoundSettingsCard` but not per-business themed.

## 4. Lightspeed Retail

- "Scanner" is a paired iOS app that broadcasts to a single register.
  Topology mirrors ours (token-paired, register-scoped channel).
- Lightspeed restricts a paired phone to one register at a time; we do
  the same on `pos:scan:<register_id>`, plus offer the broader
  `scan:session:<session_id>` topic for non-POS surfaces.
- Lightspeed surfaces "phone connected" presence in the register UI.
  Equivalent to our presence track in `useScanChannel` /
  `usePOSScannerChannel`.

## 5. Square POS

- Hardware-first (Square Stand + S089/Honeywell). Phone-as-scanner is
  not officially supported.
- Where they lead: dead-simple onboarding (plug, scan, done). Where we
  lead: works on any commodity Android phone with a camera, no Square
  hardware lock-in.

## 6. Toast POS

- Restaurant-grade; barcode workflows are limited because most items are
  PLU/keyed. Not a useful comparison for general retail scanning, but
  notable for KDS routing patterns we can learn from later.

## 7. ERPNext

- DOM-level keyboard-wedge listener registered globally. No native
  phone-as-scanner. Adding one usually means a third-party app pointing
  back at the desk via a webhook — much more brittle than our private
  Realtime channel.
- We exceed across the board on this comparison.

## 8. Zebra DataWedge

- Android hardware scanners with intent-level injection into any focused
  text field. Operationally the gold standard; out of scope for a web
  ERP, but a useful benchmark for what "scanner feels native" should
  look like (zero latency, zero focus management).
- We approximate this with: keyboard-wedge listener for USB / Bluetooth
  HID guns (already in `HidScannerDriver` + `KeyboardScannerDriver`) and
  the global `scanRouter` so focus shifts route correctly without each
  form having to wire up its own listener.

## 9. Gaps queued for a future wave

These are real enterprise gaps. Each is its own design pass and should
not be hidden inside a "polish" turn:

1. **Barcode nomenclature configurator** — per-tenant prefix rules for
   PLU, weighted barcodes, supplier-encoded packs. We parse a hardcoded
   set today; Odoo lets the merchant define their own.
2. **Lot / serial capture flow** — scan-driven lot entry on receive and
   serial pinning on sale. Requires dedicated UI plus a new
   `product_lots` / `product_serials` data model.
3. **Counting mode** — UX optimised for "scan = +1 to the same SKU"
   without a 250 ms dedupe; primitives exist (`allowRepeats`) but no
   dedicated screen.
4. **Offline-queued scans on the phone side** — if the phone loses
   connectivity mid-shift, scans should buffer locally and flush on
   reconnect (already done on the terminal side via
   `TransactionQueue.ts`; not yet on the phone).
5. **Label-printing pipeline** — generate and print product labels
   directly from a created product. Today the operator types a barcode
   into an external label tool; Odoo and Lightspeed do this in-app.
6. **Multi-device load harness** — verify the per-channel throughput at
   hundreds of concurrent phones across the same business. Should be a
   one-off scripted scenario, not a manual click-test.

## 10. Regression guards in place

- `src/test/architecture/pgcrypto-extension-prefix.test.ts` — last-def
  wins scan; fails if any `SECURITY DEFINER` function in `public` calls
  a `pgcrypto` helper without `extensions.` prefix or `extensions` on
  `search_path`.
- `src/test/architecture/realtime-scan-channel-policies.test.ts` —
  last-def wins scan; fails if any scan-related policy on
  `realtime.messages` is missing a `can_access_*` gate on either USING
  or WITH CHECK.
- `src/test/architecture/pos-single-scanner.test.ts` — ensures the scan
  kernel is registered exactly once in the app shell.
- `supabase/tests/product_identifiers_unique_shape_test.sql` — pins the
  plain-column unique constraints PostgREST's `on_conflict` requires.
