---
name: barcode-enrollment-invariants
description: Invariants for the scanner-first Barcode Enrollment Workspace (/inventory/products/enroll) — scan ownership, persistence path, queue projection, and the stale-RPC seq contract.
type: constraint
---
- The page `src/pages/inventory/BarcodeEnrollment.tsx` owns scans via ONE top-priority `useScanTarget` (priority 20, `workflow:"identity"`). Never import `scanBus` directly from the page or the reducer — the architecture guard test `barcode-enrollment-scanner-discipline.test.ts` enforces this. The scan target is gated `active: !!current && status !== "validating"` so a stray double-scan from a flaky wedge can't fire a no-op dispatch.
- Barcode persistence flows ONLY through `enroll_product_barcode` (assign), `revoke_product_barcode` (undo), and `flag_product_for_review` (flag). All three are SECURITY DEFINER, `user_can_access_business`-gated, and return structured `{status, ...}` envelopes. Never write/delete `product_identifiers` or set `products.review_reason` directly from client code on the enrollment path.
- `revoke_product_barcode` is responsible for keeping the "every product has a primary identifier" invariant — it promotes the oldest remaining identifier when the deleted row was primary. UI must never delete identifiers itself or this invariant breaks.
- Queue projection (`useProductsAwaitingBarcode`) excludes products that already have a `gtin`/`pack` identifier AND products with `review_reason IS NOT NULL`. Flagged items leave the workspace until reviewed (separate triage flow).
- Reducer (`useEnrollmentWorkflow`) stale-RPC contract: every cursor-mutating action MUST bump `state.seq` so any in-flight RPC for the previous head is dropped. Today: `SCAN_START`, `SKIP`, `JUMP`, `UNDO_RESTORE`, `QUEUE_LOADED`. If you add a new action that moves the cursor, bump `seq` too.
- The orchestrator (`submit`, `undo`, `flag`) reads from `stateRef` (mirrored via `useRef`) — not from the closure — so the `useScanTarget` registration is stable across reducer ticks. Only `businessId` belongs in their dependency arrays.
- Pairing reuses `ScannerWorkspaceProvider` / `useWorkspaceScanner` — never mint a per-page `scanner_session`.
- Sounds go through `usePOSSound` / `playPOSSound` and respect the per-device mute preference (`silent` flag on the hook).
- `flag()` advances the cursor (calls `skip()`) ONLY when the RPC returns `status:"ok"`. On any error or non-ok status the reducer dispatches `FLAG_FAILED`, the cursor stays put, and the failure surfaces through `lastError` (same inline banner as duplicate/invalid). This prevents silent UI/DB divergence — a flag the server rejected must not look completed to the operator.
- `flag_product_for_review` writes a best-effort row into `audit_logs` (`action:'flag_for_review'`, `entity_type:'product'`). The insert is wrapped in `EXCEPTION WHEN OTHERS THEN NULL` so audit schema drift can never break enrollment.
