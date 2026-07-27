# Document / Printing / Hardware — Resumption Plan (verified)

## Phase 1 — Verification of previous engineer's claims

Everything the handoff notes claimed as landed was independently confirmed against the live project:

| Claim | Check | Result |
|---|---|---|
| `document_records.document_number/date/snapshot` columns exist | `information_schema.columns` query | ✅ present |
| `ensure_document_record` is the 15-arg SECURITY DEFINER variant; 12-arg overload dropped | `pg_proc` query | ✅ only one overload, `pronargs=15` |
| Client shim `src/services/documents/ensureDocumentRecord.ts` exists | file listing | ✅ present alongside `submitIntent.ts`, `snapshots/posReceipt.ts` |
| Wave 7.1 golden fixture + test present | `supabase/functions/_shared/rendering/renderers/thermal_receipt_golden{,_test}.{json,ts}` | ✅ both present |
| Edge-fn count = 96, ceiling ratcheted to 96 with monotonic-decrease invariant | `ls supabase/functions \| wc -l` = 96; `edge-fn-inventory.test.ts` CEILING=96 | ✅ matches |
| `dispatch-print-jobs-every-minute` cron active | `cron.job` query | ✅ active, `* * * * *` |
| `@deprecated` + no-restricted-imports on `PrintClient` / `usePrintOrPreview`, grandfather allowlist in `eslint.config.js` | file inspection | ✅ present (lines 186–222) |

**Genuine current state (updated 2026-07-27, end of turn)**

- Waves 1–6 real and healthy; Wave 6 dispatcher cron already firing.
- Wave 6.5 Pass 1 complete. Pass 2 (delete `app-lifecycle`, `post-loan-interest-accrual`, `activate-organization`) still gated on publishing the TanStack build — respect that gate; do not delete pre-publish.
- Wave 7.1 (golden) and 7.1.5 (materialization RPC + POS receipt snapshot builder) landed by the prior engineer.
- **Wave 7.2 progress**:
  - `src/services/documents/snapshots/posKitchenTicket.ts` — kitchen-ticket snapshot builder (5 unit tests green).
  - `src/services/documents/snapshots/salesInvoice.ts` — sales-invoice snapshot builder + `fetchAndBuildSalesInvoiceSnapshot` Supabase fetcher matching `generate-document::fetchInvoice`'s projection (5 unit tests green). Chosen **Path A** for fork (1): each page owns its snapshot; keeps `ensure_document_record` a pure upsert.
  - `src/test/documents/snapshot-contract.test.ts` — cross-builder contract test + meta-check that every file under `snapshots/` is covered (18 tests green across 4 suites).
  - `src/components/pos/restaurant/KitchenOrderTicket.tsx` rewritten off `printClient.printKitchenTicket` onto `ensureDocumentRecord` + `submitDocumentIntent`; removed from the `no-restricted-imports` grandfather allowlist in `eslint.config.js`.
  - **`src/pages/Invoices.tsx::handlePrintInvoice` rewritten off `printClient.print` onto `fetchAndBuildSalesInvoiceSnapshot` → `ensureDocumentRecord({ kindCode: 'sales.invoice' })` → `submitDocumentIntent({ triggeredSource: 'manual' })`.** Typecheck clean; import of `PrintClient` removed from the file. `src/pages/**` still sits inside the `no-restricted-imports` grandfather allowlist because sibling pages have not migrated yet — the allowlist entry gets removed after the last sales/purchases page moves over.
- **Remaining Wave 7.2 callers** (~32 files): POS terminal (`PostPaymentSurface`, `HistoryWorkspace`, `POSReports`, `usePOSCashDrawer`, `usePrinterStatus`), sales pages other than Invoices (CreditNotes, DeliveryNotes, Estimates, ProformaInvoices, SalesOrders, SalesReturns, CustomerPayments, CustomerStatements), purchases (Bills, PurchaseOrders, PurchaseReturns, VendorStatements + peek + record page, GRN wizard), HR (Recruitment, ContractsList, LifecycleTimeline, LegalRecipients), inventory labels (Products, useLabelPrint), cross-cutting hooks (`useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient`), hardware admin (`HardwareDevices`).
- Waves 7.3 / 7.4 / 7.5 / 7.6 / 8 / 9 untouched.

**Active phase:** Wave 7.2 — mechanical page rewrite. `Invoices.tsx` is the reference implementation for the sales/purchases cluster.

**Next task (in strict order):**
1. `src/pages/CreditNotes.tsx` — create `snapshots/salesCreditNote.ts` (builder + supabase fetcher + unit tests + contract-suite entry) then rewrite call site. `document_kinds.code = 'sales.credit_note'` already exists.
2. `src/pages/Estimates.tsx` — `snapshots/salesEstimate.ts` + rewrite (`sales.estimate`).
3. `src/pages/ProformaInvoices.tsx` — `snapshots/salesProforma.ts` + rewrite (`sales.proforma`).
4. `src/pages/SalesOrders.tsx`, `src/pages/DeliveryNotes.tsx`, `src/pages/SalesReturns.tsx`, `src/pages/CustomerPayments.tsx`, `src/pages/CustomerStatements.tsx` — same pattern for each remaining sales kind.
5. Then purchases (`purchases.bill`, `purchases.po`, `purchases.return`, `purchases.statement`) — same pattern; may reuse `SalesInvoiceItemRow` shape as a starting point.
6. After all sales+purchases pages migrate, **remove `src/pages/**/*.{ts,tsx}` from the `no-restricted-imports` grandfather allowlist in `eslint.config.js`** so the ratchet gets tighter.
7. Then POS terminal (`PostPaymentSurface` etc.) — protected by Wave 7.1 golden.

**Architectural forks still unresolved:**

1. ~~**Path A vs B for page migrations.**~~ **Resolved this turn: Path A** (per-kind client-side snapshot builders). `salesInvoice.ts` is the reference implementation.
2. **`usePOSCashDrawer` (drawer_slip)** — there is no `document_kinds.code = 'pos.drawer_slip'` row and no renderer for it in the new Wave 3 engine; today the ONLY renderer lives in `generate-document`'s short-circuit calling `_shared/escpos/drawer.ts`. Migration requires (i) inserting the kind, (ii) porting `buildDrawerSlipEscPos` into `supabase/functions/_shared/rendering/renderers/`, (iii) registering it in the coverage matrix, (iv) rewriting `src/test/printing/drawer-slip-wiring.test.ts` to lock the new seam, (v) building a snapshot from the mutation inputs (all fields are already in scope). Not blocked — pure work — but crosses into Wave 7.3 (renderer coverage) not Wave 7.2 (mechanical).
3. **`reprintClient.dispatchReceiptReprint` / `dispatchLabelReprint`** — the "reprint audit" semantics are currently enforced by `execForIntent(..., isReprint: true)` at the hardware exec layer. `submitDocumentIntent({ triggeredSource: 'reprint' })` records the source at the intent layer but the downstream worker does NOT currently propagate `isReprint` onto the `print_jobs` → `hardware_command_log` chain. Need to confirm end-to-end that a Wave 5 reprint still lands a `hardware_command_log.is_reprint = true` row before folding this in, or the audit trail regresses.

**Instructions for the next agent:**
- BEFORE writing any code, verify the previous slice actually landed correctly:
  1. `bunx vitest run src/test/documents/` — MUST be 18/18 green with `sales-invoice-snapshot` and `snapshot-contract` both passing.
  2. `bunx tsgo --noEmit -p tsconfig.app.json 2>&1 | rg -i 'invoices\.tsx|salesInvoice'` — MUST be empty.
  3. `rg -n 'printClient' src/pages/Invoices.tsx` — MUST be empty (no residual PrintClient import).
  4. `rg -n 'sales.invoice' supabase/migrations` OR the live `document_kinds` table — confirm the kind code still exists.
- Only after verification passes, resume from **Next task step 1 (`CreditNotes.tsx`)**. Follow the salesInvoice.ts pattern exactly: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)` + unit test file + SUITE entry in `snapshot-contract.test.ts`. Do NOT skip any page to reach POS/hardware work — the roadmap is chronological.
- Do NOT delete the `src/pages/**` allowlist entry until ALL sales+purchases pages have migrated; removing it prematurely will break sibling page builds.




## Phase 2 — Plan additions

The existing plan is directionally correct. Add these previously-missing items:

1. **Snapshot-builder contract test** — every builder under `src/services/documents/snapshots/` must produce a JSON blob whose top-level keys match its media class's locked fixture. Add `src/test/documents/snapshot-contract.test.ts` before writing the second builder, so drift is caught the moment a new builder lands.
2. **Idempotency at the ensureDocumentRecord seam** — assert (test + code comment) that calling `ensureDocumentRecord` twice with the same `(org, source_module, source_doc_type, source_doc_id)` returns the same `document_record_id` and does NOT create a second `print_jobs` row when the second `submitDocumentIntent` runs with the same scenario. Guards double-print on POS retry.
3. **Reprint path parity** — `src/services/printing/reprintClient.ts` also imports `PrintClient`. Fold reprint into `submitDocumentIntent({ triggered_source: 'reprint' })` in Wave 7.2 so reprint is not left as a second chokepoint that Wave 7.3 would have to delete separately.
4. **Label printing (Products, `useLabelPrint`)** — the audit lists label print among Wave 7.2 callers but the snapshot list in the handoff omits contract details. Add: label snapshot builders (`inventory.product_label`, `inventory.shelf_label`, etc.) MUST honor ADR-0088 (mm-relative geometry) and ADR-0089 (barcode identity — never emit UUID). Add a lint/test guard that refuses to render a label when `resolveLabelBarcode` returns `null`.
5. **Kitchen ticket golden** — before rewriting `KitchenOrderTicket.tsx`, lock a second byte-parity fixture (`kitchen_ticket_golden.json`) analogous to Wave 7.1. Kitchen tickets have different cut/beep semantics than customer receipts and need their own gate.
6. **Wave 7.6 fast-path guard** — the `pg_net.http_post` fast-path from `submit_document_intent` must be idempotent w.r.t. the cron tick (both may claim the same job). Add a test that a job is dispatched exactly once even when both paths race.
7. **Wave 9 destructive migration safety** — before dropping `receipt_settings`, add a migration-time assertion that every row's semantics have a home in `document_theme` / `document_header_footer`; fail the migration otherwise.

## Phase 3 — Execution order

Execute in strict order. Do not open a later step before the previous is production-ready.

### Wave 7.2 — Mechanical rewrite (allowlist → 0)

For each module, land in one commit: snapshot builder + unit test + call-site rewrite + eslint allowlist entry removal + relevant golden green.

1. **POS terminal** (protected by 7.1 golden):
   - Land `snapshots/posKitchenTicket.ts` + lock `kitchen_ticket_golden.json`.
   - Rewrite `apps/pos/terminal/receipt/PostPaymentSurface.tsx`, `components/pos/restaurant/KitchenOrderTicket.tsx`, `apps/pos/terminal/history/HistoryWorkspace.tsx`, `hooks/pos/usePOSCashDrawer.ts`, `hooks/pos/usePrinterStatus.ts`, `pages/pos/POSReports.tsx`.
   - Remove `src/apps/pos/**`, `src/hooks/pos/**`, `src/components/pos/restaurant/KitchenOrderTicket.tsx` from allowlist.
2. **Sales pages** — invoice, credit note, delivery note, estimate, proforma, sales order, sales return, customer payment, customer statement. One snapshot builder per `document_kinds.code`; rewrite pages; drop allowlist entries.
3. **Purchases** — bill, PO, purchase return, vendor statement (peek + record page), GRN wizard. Same pattern.
4. **HR** — recruitment, contracts list, lifecycle timeline, legal recipients (payroll).
5. **Inventory labels** — `Products.tsx`, `hooks/inventory/useLabelPrint.ts` — enforce ADR-0088/0089 guards.
6. **Cross-cutting hooks / components** — `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient` (fold into `submitDocumentIntent` per Phase 2 item 3).
7. Hardware settings page `apps/platform/hardware/HardwareDevices.tsx` — only if it truly prints; else drop the import.
8. Land contract + idempotency tests from Phase 2 items 1–2.

Exit: no-restricted-imports allowlist for `PrintClient`/`usePrintOrPreview` is empty; every golden green; smoke tests under `e2e/` pass.

### Wave 7.3 — Delete legacy chokepoint

Delete `src/services/printing/PrintClient.ts`, `src/hooks/usePrintOrPreview.ts`, `BrowserHardwareAdapter.print`, `reprintClient.ts`. Delete the no-restricted-imports rules (unnecessary once the files are gone). Update tests that referenced them.

### Wave 7.4 — Feature flag

`POS_CHOKEPOINT_V2` env-driven flag with one-release dual-write (v1 path already deleted, so dual-write means "server-side dispatch fallback" — implement as a `submit_document_intent` param).

### Wave 7.5 — Architecture guards

New arch tests: no `PrintClient` imports; no client-side `print_jobs` inserts; no client-side `document_records` inserts; no `window.print()` outside preview surface; snapshot-contract test (Phase 2 item 1); label-identity guard (Phase 2 item 4).

### Wave 7.6 — Latency fast-path

`submit_document_intent` fires `pg_net.http_post` to `dispatch-print-jobs` when `scenario='on_close'`. Add race-idempotency test (Phase 2 item 6).

### Wave 8 — Transport router consolidation

- Fold `BrowserHardwareAdapter` / Electron `CommandRouter` / `LocalAgent` behind one `TransportRouter`.
- Drain `window.pos.*` reads inside `HardwareClient.ts`; drive `host-router-single-source.test.ts` allow-list to zero.
- Capability negotiation via `hardware_capabilities` so scales / biometric / RFID plug in with no adapter changes.

### Wave 9 — Legacy deletion

- Publish TanStack build; unblock Wave 6.5 Pass 2; delete `app-lifecycle`, `post-loan-interest-accrual`, `activate-organization`; ratchet CEILING → 93, then continue toward ≤ 87.
- Drop `receipt_settings` with the pre-drop assertion migration (Phase 2 item 7).
- Retire v1 `document_templates` shim; drop deprecated RPCs/triggers with zero call sites.
- Remove `@deprecated` sentinels.
- Replace wave-by-wave audits with a single `docs/architecture/DOCUMENT_PRINT_HARDWARE.md` overview covering: business event → document_record → template → renderer → output intent → print_jobs → dispatcher → transport → device.

## Cross-wave invariants (unchanged, do not violate)

- Every new `public` table: `GRANT` + `ENABLE RLS` + policies in the same migration.
- Only `submit-document-intent` inserts into `print_jobs`; only `dispatch-print-jobs` calls `claim_print_jobs`.
- No new edge fn may wrap another edge fn.
- Hardware ops only through `hardwareClient`; no direct `window.pos.*` outside HostRouter allow-list.
- `.lovable/plan.md` top-of-file status table updated at the end of every wave.

## Technical details

- Snapshot builder shape: `{ document_number: string, document_date: string (ISO), snapshot: Record<string, unknown> }`. Top-level keys of `snapshot` must match the locked fixture for the media class.
- Call site pattern:
  ```ts
  const built = buildXSnapshot(source);
  const recordId = await ensureDocumentRecord({ kindCode, organizationId, sourceModule, sourceDocType, sourceDocId, businessId, branchId, partyKind, partyId, currency, locale, metadata, ...built });
  await submitDocumentIntent({ documentRecordId: recordId, scenario });
  ```
- Reprint: `submitDocumentIntent({ documentRecordId, scenario, triggered_source: 'reprint' })` — no separate client.
- Idempotency: `ensure_document_record` upserts on `(org, source_module, source_doc_type, source_doc_id) WHERE superseded_by IS NULL`; `submit_document_intent` should upsert `print_jobs` on `(document_record_id, scenario, target_hash)`; verify and add if missing during Wave 7.2 step 1.
