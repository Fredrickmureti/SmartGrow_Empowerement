# Wave 7 — POS Receipt Convergence

**Goal:** every POS receipt, drawer slip, kitchen ticket and reprint flows through `submit_document_intent` → `output_intent` → `print_jobs` → `dispatch-print-jobs` → hardware. The legacy `PrintClient` / `ReceiptTemplateGenerator` / `useDocumentPrint` stack is deleted.

## Scope (in)

1. **POS sale close** (`src/hooks/pos/*`, `src/pages/POS*`, checkout flows) — replace direct `PrintClient.print(...)` with `submitIntent({ documentKind: 'pos.receipt', sourceDocId, scenario: 'on_close' })`.
2. **Drawer slip / cash-in-out** — `pos.cash_slip` kind, `scenario: 'drawer'`.
3. **Kitchen tickets** — `pos.kitchen_ticket` kind, routed via `hardware_role='kitchen'`.
4. **Reprint** — `src/services/printing/reprintClient.ts` becomes a thin wrapper around `submitIntent({ scenario: 'reprint' })` using the existing `document_records.id`.
5. **Label print from Products** — `inventory.label` kind through the same chokepoint.
6. **Renderers** — port `ReceiptTemplateGenerator` output into `supabase/functions/_shared/rendering/renderers/thermal-receipt.ts` (already scaffolded in Wave 3) so the server produces the artifact instead of the browser.

## Scope (out — deferred to Wave 8/9)

- Physical hardware adapter internals (`BrowserHardwareAdapter`) — Wave 8.
- Deletion of legacy tables (`document_templates`, `receipt_settings`) — Wave 9.
- Fiscal/ETIMS transmission changes — already Wave 5.

## Execution order

### 7.1 Server-side receipt renderer

- Move receipt-line building from `src/lib/pos/receipt/ReceiptDocumentModel.ts` into `supabase/functions/_shared/rendering/renderers/thermalReceipt.ts`. Keep the model as a pure builder importable by both.
- Add `document_kinds` rows if missing: `pos.receipt`, `pos.cash_slip`, `pos.kitchen_ticket`, `inventory.label`.
- Ensure `output_intents` seed rows exist per org for these kinds (bootstrap trigger `_wave7_seed_pos_intents`).

### 7.2 Client chokepoint adoption (mechanical)

Grep-driven rewrite. For each caller of `PrintClient.print`, `useDocumentPrint`, or `ReceiptTemplateGenerator.print`:

```ts
// before
await printClient.print(receiptPayload, { deviceId });
// after
await submitIntent({
  documentKind: 'pos.receipt',
  sourceModule: 'pos',
  sourceDocId: transactionId,
  scenario: 'on_close',
  renderParams: { copies: 1 },
});
```

Files touched (representative):
`src/hooks/pos/usePrinterStatus.ts`, `usePOSCashDrawer.ts`, `usePrintOrPreview.ts`, `useDeviceForIntent.ts`, `useLabelPrint.ts`, `src/services/printing/reprintClient.ts`, `src/pages/Products.tsx`, `src/pages/Invoices.tsx`, `src/pages/CustomerStatements.tsx`, `src/pages/VendorStatements.tsx`, POS checkout components.

### 7.3 Delete client-side print transport

- Delete `src/services/printing/PrintClient.ts` and its browser hardware IPC bridge (`BrowserHardwareAdapter.print`).
- Delete `src/hooks/usePrintOrPreview.ts` (replaced by `submitIntent` + preview shim reading the rendered artifact URL).
- Keep `useReceiptSettings` for on-screen preview only; strip its "print" affordance.

### 7.4 Feature flag & rollout

- Add `POS_CHOKEPOINT_V2` flag in `src/lib/featureFlags.ts`.
- Dual-write for one release: when the flag is off, keep legacy `PrintClient` path; when on, call `submitIntent`. Flag defaults on in dev, off in prod until QA signs off.
- Remove flag + legacy path at end of Wave 7.

### 7.5 Guards

- Architecture test: no file under `src/` (except `submitIntent.ts`) imports `PrintClient`.
- Architecture test: no direct `.from('print_jobs').insert` in client code.
- Runtime assertion in `submitIntent` that `document_kind` starts with `pos.` uses `scenario in ('on_close','drawer','kitchen','reprint')`.
- E2E (Playwright): close a POS sale → assert a `print_jobs` row queued within 500ms, an `output_dispatch_log` row within 3s, and the receipt artifact renders identically to the legacy path (snapshot compare on the returned PDF/ESCPOS bytes).

## Technical notes

- **Order preserved:** ESCPOS byte sequences must match legacy output byte-for-byte to avoid re-cutting printer profiles. The snapshot test in 7.5 enforces this.
- **Latency budget:** `submit_document_intent` → drainer → device round-trip must stay ≤2s at p95 for the POS close hot path. The drainer currently runs every 60s (Wave 6 cron). Wave 7.6 changes that cron to every 15s AND adds a direct-invoke fast path from `submit_document_intent` (`pg_net.http_post`) when the intent's scenario is `on_close` — the cron becomes a safety net.
- **Idempotency:** relies on the Wave 6 `dedupe_key` partial-unique index; POS reprint uses `scenario='reprint'` so it does not collide with the original.

## Risk

- Highest risk is the direct-invoke fast path (7.6) — if the edge function is cold-started, POS close could stall. Mitigation: fire-and-forget, do not `await` from the SQL side; the cron guarantees eventual delivery.

## Deliverable checklist

- [ ] `_wave7_seed_pos_intents` trigger + backfill migration
- [ ] `thermalReceipt.ts` renderer + byte-parity test
- [ ] `POS_CHOKEPOINT_V2` flag + dual-write
- [ ] All POS/label/reprint callers routed through `submitIntent`
- [ ] Legacy `PrintClient`, `usePrintOrPreview`, browser `BrowserHardwareAdapter.print` deleted
- [ ] Fast-path invoke from `submit_document_intent` (`pg_net`)
- [ ] Architecture guards green
- [ ] Plan.md flipped to ✅
