# Scan-Semantics & Inventory-Onboarding Re-Audit

_Date: 2026-05-19_

Plan file: `.lovable/plan.md` (approved). This is the durable audit record.

## Verdict

The scan architecture is **sound**. The router (`src/services/pos/scanRouter.ts`)
implements focus-aware target precedence with a privileged pre-listener and a
`consumedEvents` WeakSet that prevents double-dispatch to legacy `scanBus.on`
consumers. The workspace-scoped scanner session
(`src/contexts/ScannerWorkspaceContext.tsx`) gives the phone a single
ownership boundary across every form in the workspace. POS cart accumulation
(quantity-oriented) and Add-Item identity capture (identity-oriented) are
isolated by router priority — POS cart only fires when no inventory target
is mounted. The "POS scan logic leaks into inventory" claim from the brief
does **not** match the code.

The user-visible "second scan creates another row" symptom is a real bug,
but it lives in two narrow places:

1. **`ProductIdentifiersEditor` fallback target (priority 5)** appended a
   new row when no row's `code` matched the scan, but the local dedupe never
   consulted `product_identifiers` for cross-product collisions. After a
   focused per-row scan, `nextFocusRef` advanced focus away from the
   barcode field — the next scan landed on the fallback target and silently
   added a row.

2. **`useScanChannel`** emitted to `scanBus` without a `scanId`, defeating
   the bypass-proof LRU dedupe. Supabase Realtime re-delivery (>250 ms after
   the original) slipped through the timing window.

3. **`commit()`** used `ignoreDuplicates: true` on the `product_identifiers`
   upsert, so a barcode that belonged to another product was silently
   dropped at save time — the user thought it was saved.

## Changes shipped

- `src/hooks/pos/useScanChannel.ts` — stamps `scanId = device_id|seq` (or
  producer-supplied `scan_id`) on every emit. Matches `usePOSScannerChannel`,
  which already did this.
- `src/components/products/ProductIdentifiersEditor.tsx`
  - Fallback target no longer appends. It either fills the first empty row,
    toasts "already in the list", or toasts "no empty slot — click + Add".
  - After filling, it calls `pos_resolve_barcode` and clears the row if the
    code already belongs to a different product, surfacing a destructive
    toast.
  - `commit()` switched from `upsert(..., ignoreDuplicates: true)` to plain
    `insert(...)` so the `(business_id, code_norm, kind)` unique constraint
    surfaces collisions instead of dropping them silently.
- `src/services/pos/scanRouter.ts` + `src/hooks/pos/useScanTarget.ts` — new
  `ScanWorkflow` tag (`identity | quantity | count | receive`) on
  `ScanTargetEntry`. Declarative; runtime dispatch is still
  priority-based. Lets future targets declare semantics so a stack like
  `[identity priority 10, quantity priority 20]` becomes lint-detectable.
- `src/components/scanner/BarcodeInputField.tsx` tagged `workflow:
  "identity"`. POS terminal cart and `ProductIdentifiersEditor` fallback
  tagged accordingly.

## Tests

- `src/test/pos/scan-workflow-tag.test.ts` (new) — pins the workflow-tag
  contract on registered targets and confirms the tag does not change
  runtime dispatch.
- Existing `src/test/pos/scanRouter.test.ts`,
  `src/services/pos/__tests__/scanBus.dedupe.test.ts`, and
  `src/test/architecture/pos-single-scanner.test.ts` continue to enforce
  precedence + dedupe invariants.

## Out of scope (intentionally not changed)

- `scanRouter` / `scanBus` / `ScannerWorkspaceContext` core — correctly
  designed.
- POS cart scan accumulation at priority 0 — correct behavior.
- Camera fallback in `ProductIdentifiersEditor` (BarcodeDetector / ZXing) —
  its `handleDecoded` path already dedupes via local row check.
- Physical Count / Goods Receipt / Transfers — already use
  `allowRepeats: true` correctly; only inherit the workflow-tag convention.

## Follow-ups (not blocking)

- ESLint rule that fails the build when a `quantity` / `count` target is
  registered while an `identity` target is on the stack at lower priority.
- Surface the `pos_resolve_barcode` warning in `BarcodeInputField` as a
  blocking submit-time check on the parent product form (currently the
  Save button does not consult per-row duplicate state).
