# Scanner Architecture — Continuation Audit Log (P2 + P4a + P5)

## Verified before starting

- P3 (`useScannerConnectionMachine` + `useScannerSessionRevocation` + 21-row test) was real and wired in `MobileScannerPage.tsx:46,660`.
- P1+ intent contract still locked by `src/test/pos/intent-contract.test.ts`.

## Shipped this turn

### P2 — Per-intent replay policy + Sales review drawer
- `src/services/scanner/replayPolicy.ts` — pure `decideReplayPolicy({intent, decodedAt, receivedAt})`. `pos_sell` / `identity` always auto-apply; `doc_author` / `inventory_count` / `inventory_receive` auto-apply only when within `LIVE_WINDOW_MS` (2 s), otherwise → `review_queue`.
- `ScanEvent.decodedAt?: number` plumbed through `scanBus`, `useScanChannel`, `usePOSScannerChannel`.
- `SalesScanContext` extended with `inbox` + `acceptInboxItem` / `discardInboxItem` / `acceptAllInbox` / `clearInbox`. Stale `doc_author` scans now land in the inbox instead of mutating live drafts.
- `src/components/sales/SalesScanReviewDrawer.tsx` — floating, collapsible panel mounted in `SalesLayout` above the existing scan chip. Renders nothing when the inbox is empty.
- Locked test: `src/test/scanner/replay-policy.test.ts` (8 cases).

### P4a — Device-id persistence + telemetry
- `src/services/scanner/deviceIdentity.ts` — pure `resolveDeviceId(local, session)`. `localStorage` first, `sessionStorage` legacy fallback (migrated forward), generates new UUID if neither exists.
- Emits `[scanner.telemetry] refresh_burned_token` console marker on legacy-only state so operations can observe the historical bug fading.
- `MobileScannerPage.getDeviceId()` rewritten to call the helper.
- Locked test: `src/test/scanner/device-id-persistence.test.ts` (5 cases including refresh-idempotency).

### P5 — DIALOG_READY handshake + namespace cleanup
- `src/services/scanner/dialogReadyBus.ts` — tiny scope-keyed pub/sub. Producers call `signal(scope)`, consumers `await waitFor(scope, timeoutMs)`.
- `SalesScanContext.registerDraftController` signals `"sales.draft"` on mount.
- `Invoices.openDraftFromScan` replaces the racy 600 ms `setTimeout` with `dialogReadyBus.waitFor("sales.draft")` (1500 ms safety).
- Non-POS imports of `@/services/pos/scanFeedbackBus` rewritten to `@/services/scanner` in `ProductIdentifiersEditor`, `BarcodeInputField`, `useEnrollmentWorkflow`.
- Locked tests: `src/test/scanner/dialog-ready-bus.test.ts` (5 cases) + `src/test/architecture/non-pos-uses-scanner-namespace.test.ts` (guard against future regressions).

## Verified post-change

`bunx vitest run src/test/scanner/ src/test/architecture/non-pos-uses-scanner-namespace.test.ts` → 25 files / 159 tests / **all passing**.

## Deliberately deferred

- **ScanIntentBoundary** component (`<ScanIntentBoundary intent="doc_author">`) — the runtime intent-conflict check in `scanRouter.register` already errors loudly on violations; the boundary is structural defence-in-depth but lower ROI than P4b.
- **Rapid-mode "dialog opens once" integration test** — DIALOG_READY handshake makes this a near-deterministic effect; the bus is unit-tested. A full React-tree integration test was skipped for scope.
- **Phone-side `client_intent_hint` tagging via desk presence** — desk has authoritative info (`decodedAt` + currently-mounted target intent), so the policy works without phone cooperation. Phone tagging is a future optimization, not a correctness gap.
- **P4b — `scanner_device_trust` table + silent reclaim RPC** — single largest remaining wave, requires DB migration. Scoped for the next turn.

## Out of scope (unchanged)

Native scanner SDK bridges; POS `pos_sell` semantics; `pos_resolve_barcode` rename; cockpit migration off `useScannerHealth`.

---

Ready for P4b (device trust + silent reclaim RPC, includes migration) on the next turn.
