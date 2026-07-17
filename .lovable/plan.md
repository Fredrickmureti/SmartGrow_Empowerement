## Verification summary

Spot-checked prior engineer's claims in `.lovable/plan.md`:

- ADRs 0064–0070 present on disk ✅
- `InboundShipments.tsx`, `InboundShipmentDetail.tsx`, `Lots.tsx`, `LotDetail.tsx` present ✅
- Guards `inbound-shipments-ui.test.ts`, `lot-genealogy-ui.test.ts`, `outbound-lot-serial-ui.test.ts`, `serial-tracking.test.ts` present ✅
- `src/lib/gs1/` does not exist → Phase H is genuinely next, not partially done ✅
- (Vitest runtime not available in sandbox; cannot re-execute suites — relying on file-level verification.)

State matches the log. Resuming at **Phase H — GS1 AI parsing**, exactly as the pick-up instruction directs.

## Phase H — GS1 barcode parsing & scanner wiring

Goal: single scan of a GS1-128 / DataMatrix label yields `{ gtin, lot, expiry, serial, quantity }` at every inbound and outbound capture surface, without schema or RPC changes.

### 1. Pure parser (land first)

- `src/lib/gs1/aiTable.ts` — Application Identifier table with `{ ai, name, fixedLength?, dateFormat?, decimalIndicator? }` metadata. Cover at minimum: `00` SSCC, `01` GTIN, `02` GTIN of contained, `10` batch/lot (var), `11` production date, `13` packaging date, `15` best-before, `17` expiry, `20` variant, `21` serial (var), `30` count (var), `310n`–`316n` weight/measure with decimal indicator, `37` count of units, `240` additional item id, `241` customer part, `310n` net weight kg. FNC1 = `\x1d` group separator.
- `src/lib/gs1/parseGs1.ts` — `parseGs1(raw: string): { ok: true; elements: Record<string, string>; normalized: { gtin?; lot?; expiry?: Date; serial?; quantity?: number } } | { ok: false; error }`. Handles: optional leading FNC1/`]C1`/`]d2` symbology prefix, fixed-length AIs, variable-length AIs terminated by FNC1 or end-of-string, `310n`-family decimal placement, YYMMDD → Date with day=00 → last day of month (GS1 rule), unknown AI → soft-fail with partial result.

### 2. Scanner hook

- `src/lib/gs1/useGs1Scanner.ts` — thin adapter over existing scan input; if payload parses as GS1 return structured object, else fall through to legacy single-code behaviour. No new event bus — reuses the scanner kernel already in `@/services/scanner`.

### 3. Wire into capture surfaces (highest value first)

- `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx` — line scan: resolve product by GTIN, prefill lot + expiry + quantity in the wizard row.
- `src/components/inventory/LotPickerPopover.tsx` — accept scanned `{ lot, expiry }`; if lot doesn't exist for the product, offer inline-create using expiry from scan.
- `src/components/inventory/SerialPickerPopover.tsx` — accept scanned `serial`; validate against `stock_serials` for the product/warehouse.
- POS scan input — audit `src/features/pos/` scanner mount points; if present, plug the hook in; if the surface routes through `@/services/scanner` already, wiring is a single adapter call. Do NOT add POS-specific UX in this phase.

### 4. Doctrine + guards

- `docs/adr/0071-gs1-scanner-parsing.md` — records: GS1 is the canonical inbound barcode grammar; internal barcodes remain the legacy path; parser is pure and lives in `src/lib/gs1/`; every capture surface goes through `useGs1Scanner`.
- `src/lib/gs1/parseGs1.test.ts` — table tests covering each AI in `aiTable.ts` + FNC1 boundaries + malformed input.
- `src/test/architecture/gs1-parsing.test.ts` — enforces: (a) `parseGs1.ts` imports only from `./aiTable`, (b) every listed capture surface imports `useGs1Scanner`, (c) no capture surface hand-parses AI codes.

### 5. Success criteria

- Parser unit tests green.
- Architecture guard surface grows from 112 → ~125, all green.
- No schema changes, no RPC changes, no migrations.
- GRN wizard demo: paste a sample GS1-128 payload (`01034531200000111709112510ABC1234` + FNC1 + `21XYZ987`) → product + lot + expiry + serial resolved in one action.

### Explicitly deferred (unchanged from prior plan)

- Phase E product variants, Phase F import split, Phase 5 `warehouse_stock` retirement.
- Sales-order / delivery-note / sales-return edit-page pickers (surfaces don't exist).