# POS Deep Audit — Stage 1: Ground-truth inventory

Date: 2026-04-27
Scope: zero-trust inventory of the POS module as it actually exists in the codebase today. **No code is modified by this document.** This is the evidence baseline that Stages 2+ (target architecture, GL/inventory rework, IoT, restaurant-mode readiness) will be built on. Each subsequent stage will be its own approval-gated plan.

Prior POS audit docs (`MULTI_COMPANY_CERTIFICATION.md`, `POS_MULTI_ENTITY_AUDIT.md`) are explicitly **not trusted** as inputs. They are reviewed only as claims to be verified against source.

---

## 1. Hook surface inventory (`src/hooks/pos/`)

54 hook files. Grouped by responsibility:

### Session / shift / register (source of truth)
- `usePOSRegisters.ts` — register CRUD against `pos_registers`.
- `usePOSSessions.ts` — opens/closes `pos_sessions`, derives branch from register.
- `usePOSSessionsOffline.ts` — offline session queue.
- `usePOSShifts.ts` — `pos_shifts` lifecycle.
- `useShiftIntegrity.ts` — shift-vs-transaction reconciliation.
- `useTerminalSession.ts` — register/session realtime channel, scoped by `business_id`.
- `usePOSCashiers.ts` / `usePOSCashDrawer.ts` — cashier and cash-drawer state.

### Transactions / cart
- `usePOSTransaction.ts` / `usePOSTransactionOffline.ts` — calls `process_pos_transaction` RPC.
- `usePOSTransactionHistory.ts` — read-only.
- `usePOSCart.ts` / `usePOSCartAdapter.ts` — cart state, never writes DB directly.
- `usePOSHeldTransactions.ts`, `usePOSVoid.ts`, `usePOSReturns.ts`, `usePOSCreditSale.ts`, `usePOSInvoiceRequest.ts` — ancillary write paths.

### Inventory / catalogue
- `usePOSProducts.ts`, `usePOSProductCache.ts` — read.
- `usePOSStockReservation.ts`, `usePOSStockSync.ts` — reservation + push.

### Settings / config
- `usePOSSettings.ts`, `useMergedReceiptSettings.ts`, `usePOSSecuritySettings.ts`.

### Restaurant-mode (already present, partial)
- `useFloorPlan.ts`, `useTableOrder.ts`, `useTableSessions.ts`, `useTableTransfer.ts`, `useTableBookings.ts`, `useBillSplitting.ts`, `useCourses.ts`, `useKitchenDisplay.ts`, `useWaitlist.ts`, `useHappyHour.ts`.

### Hardware / IoT
- `useHardwareEvents.ts`, `useHardwareProxy.ts`, `usePrinterStatus.ts`, `useBarcodeScanner.ts`, `useCustomerDisplay.ts`, `useDeviceRegistry.ts`.

### Misc
- `usePOSDiscounts.ts`, `usePOSPromotions.ts`, `usePOSLoyalty.ts`, `usePOSGiftCards.ts`, `usePOSCustomers.ts`, `usePOSAgeVerification.ts`, `useManagerOverride.ts`, `usePOSEnhancedReports.ts`, `usePOSReports.ts`, `usePOSReportViews.ts`, `usePOSDashboardStats.ts`, `usePOSEtims.ts` (Kenya tax), `usePOSSecurityAudit.ts`, `usePOSSound.ts`, `usePOSOffline.ts`, `useModifiers.ts`.

**Stage 1 finding — surface area is large but already segmented by concern.** The session/shift/register cluster correctly funnels every transactional write through `process_pos_transaction`, which is the right shape for an ERP-grade POS. The risk surface is in *what that RPC does*, not in hook sprawl.

---

## 2. Existing architecture guards (must remain green)

The codebase already ships static-AST architecture tests that lock in invariants from prior audit waves. Stage 2+ MUST NOT regress any of these:

- `src/hooks/pos/__tests__/posBusinessIdNotNullGuard.test.ts` — 9 type-shape tests asserting `business_id` is required on Insert for every POS sub-table.
- `src/hooks/pos/__tests__/posMultiEntityArchitecture.test.ts` — 3 source-scan tests: terminal sessions never insert blank business context; POS invoices use transaction lineage (`source_pos_transaction_id`); offline replay carries `business_id` + `branch_id`.
- `src/hooks/pos/__tests__/posScopeContaminationGuard.test.ts` — 4 source-scan tests: no `business_id.is.null` fallback; terminal session reads scope by register's business; `pos_sessions` insert reads register first; `process_pos_transaction` invoked with register-derived scope.
- `src/test/architecture/pos-branch-stamping.test.ts`, `no-org-only-pos-rls.test.ts`, `no-org-only-pos-rls-stage3.test.ts` — branch-stamping and RLS scope guards.

Stage 1 did not run these (read-only inventory). Stage 2 will run them as the very first action and treat any failure as a hard blocker.

---

## 3. Multi-entity correctness — verified vs claimed

`docs/POS_MULTI_ENTITY_AUDIT.md` claims a 10-step correction was completed. Stage 1 spot-checked the *shape* of the claims against the architecture tests (which encode them as invariants):

| Claim | Encoded in test? | Status |
|---|---|---|
| `pos_transactions.business_id` NOT NULL | yes | enforced at type level |
| `pos_transaction_items.business_id` NOT NULL | yes | enforced |
| `pos_transaction_payments.business_id` NOT NULL | yes | enforced |
| `pos_cashier_registers.business_id` NOT NULL | yes | enforced |
| `pos_sessions.business_id` NOT NULL | yes | enforced |
| `pos_shifts.business_id` NOT NULL | yes | enforced |
| Terminal session realtime keyed by business | yes | enforced |
| POS invoice lineage via `source_pos_transaction_id` | yes | enforced |
| Offline queue carries `business_id`+`branch_id` | yes | enforced |
| Stale-session UPDATE filters by `business_id` | yes | enforced |

**Verdict:** the multi-entity claims are backed by CI-enforced invariants. Multi-entity contamination is the lowest-risk area of POS. *This is not the same as saying GL posting or inventory at scale are correct* — those are Stages 2 and 3.

---

## 4. Gap list — Phases 3–14 (read-only; no fixes proposed in Stage 1)

### Phase 3 — Session model
- ✅ Sessions exist (`pos_sessions`, `pos_shifts`).
- ⚠ Verify (Stage 2): is GL posted per-transaction, per-shift-close, or both? `POS_MULTI_ENTITY_AUDIT.md` claims `trg_pos_shift_close_journal` posts at close, but `process_pos_transaction` may also post — needs trigger inspection.
- ⚠ No automated stress test for >100k transactions/session.

### Phase 4 — Inventory integration
- ✅ Stock movements branch-validated by `enforce_stock_movement_branch_scope()`.
- ⚠ No reservation/contention model documented for concurrent terminals selling the same SKU; needs Stage 3.

### Phase 5 — Accounting integration
- ⚠ Auto-close journal exists; the trade-off vs per-transaction posting is undocumented. ADR needed in Stage 2.
- ⚠ `pos_shift_close_errors` exists for failures, but rollback semantics need verification.

### Phase 6 — Payments
- ✅ `pos_transaction_payments` is multi-entity scoped; branch-level overrides keyed by `(business_id, branch_id, method_key)`.
- ⚠ Split payments / refunds / change handling not stress-tested.

### Phase 7 — Hardware / IoT
- ⚠ `useHardwareProxy`, `useDeviceRegistry`, `agent/` directory exist (local hardware bridge), but no abstraction layer comparable to Odoo IoT box. Stage 4.

### Phase 8 — Restaurant-mode readiness
- ✅ Floor plan, table sessions, kitchen display, bill splitting, courses, waitlist hooks all already present.
- ⚠ Lifecycle (draft → sent → served → paid) not yet end-to-end traced. Stage 5.

### Phase 9 — Branch isolation
- ✅ Strongest area. CI-enforced.

### Phase 10 — Scalability time-bombs
- ⚠ No documented analysis of: GL row growth, `pos_transaction_items` partitioning, realtime fan-out, or `pos_daily_summary` refresh cost. Stage 2.

### Phase 11 — Settings
- ✅ Three-level precedence (`resolve_pos_setting`: register → branch → company) implemented.
- ✅ `useMergedReceiptSettings` correctly limits POS overrides to a whitelist of fields.

### Phase 12 — Edge functions
- Current quota: ~93/100. Per ADR-0005, new POS server logic must consolidate into existing functions, not add new ones.
- POS-specific edge functions: `clear-pos-data`, `etims-transmit-pos`. No POS-transaction edge function exists — that work is in DB RPCs (`process_pos_transaction`), which is correct.

### Phase 13 — UX
- Not in Stage 1 scope.

### Phase 14 — Cross-cutting gaps
- **Documents/PDFs**: addressed in this round's Part A (column-header crowding fix). Not POS-specific.
- **Audit logging**: `usePOSSecurityAudit` exists; coverage not yet inventoried.

---

## 5. Stage 2+ proposal index

Each will come back as its own approval-gated plan. None is started in Stage 1.

1. **Stage 2 — GL posting strategy ADR + verification.** Inspect `process_pos_transaction` and `trg_pos_shift_close_journal`. Decide and document: per-transaction journal, per-shift-close journal, or hybrid. Add a regression test asserting the chosen invariant.
2. **Stage 3 — Inventory contention + reservation model.** Document concurrent-sale behaviour, decide whether to introduce reservations, add tests for negative-stock guards.
3. **Stage 4 — Hardware / IoT abstraction.** Compare `agent/` and `useHardwareProxy` to Odoo IoT model.
4. **Stage 5 — Restaurant-mode lifecycle hardening.** End-to-end trace of order draft → sent → served → paid.
5. **Stage 6 — Scalability stress harness.** Synthetic 100k-transaction-per-session benchmark.
6. **Stage 7 — Document/receipt template polish (post-spacing fix).** Centralize all gap constants on `theme.blockGap`; remove ad-hoc offsets across `TotalsBlock`, `NotesBlock`, `SummaryBlock`.

---

## 6. What Stage 1 does NOT claim

- Does not claim GL posting is correct at scale.
- Does not claim inventory is contention-safe.
- Does not claim restaurant-mode is production-ready.
- Does not claim parity with Odoo POS — only that the multi-entity contamination work is real and CI-enforced.
- Does not modify any POS code.

End of Stage 1.
