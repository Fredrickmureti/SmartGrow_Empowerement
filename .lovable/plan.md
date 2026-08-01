# Product Identification Architecture — Verification Report & Revised Plan

## Phase 1 — What I verified (evidence, not claims)

**Phase A (canonical model) — genuinely landed.** Confirmed directly against the live database, not just the migration file: `product_identifiers.packaging_id` exists, the `trg_product_identifier_packaging_guard` trigger exists, `product_identification_waivers` exists with GRANTs + RLS + policies + unique level index, and all three RPCs (`resolve_product_identity`, `product_identification_status`, `waive_product_identification`) exist. `pos_resolve_barcode` was rewritten to delegate item identity to the resolver; comparing it line-by-line against the prior version (migration `20260527141306`), the weighted-barcode rule parsing, embedded price/weight extraction and the returned column list are preserved.

**Phase B (level-aware enrollment) — landed.** `useIdentificationQueue`, `useEnrollmentWorkflow` (with `EnrollmentTarget` + waive) and the rebuilt `BarcodeEnrollment` page exist and read the status projection.

**Phase C — correctly reported as not started.** No client file references `resolve_product_identity` (only the generated types file does).

## Phase 1 — Defects found in "completed" work

These are real and must be fixed before Phase C is layered on top.

1. **Blocking correctness bug: normalization mismatch.** `product_identifiers.code_norm` is a generated column defined as `lower(code)`. Every new Phase A function compares against `upper(...)`: the resolver uses `pi.code_norm = upper(code)`, and `enroll_product_barcode` computes `v_norm := upper(btrim(code))` for its idempotency, duplicate-conflict and unique-violation lookups. For purely numeric barcodes `lower` = `upper`, so EAN/UPC scanning masks the bug; **every alphanumeric identifier (supplier codes, internal codes, pack aliases, SKU-style codes) silently fails to resolve and silently fails duplicate detection**. `code_norm` also lacks `btrim`, so `" ABC"` and `"ABC"` both pass the unique constraint.
2. **Tenant-isolation gap in the new RPCs.** `resolve_product_identity` and `product_identification_status` are `SECURITY DEFINER` with **no `user_can_access_business` check**, and `resolve_product_identity` is granted to `anon`. Any caller who supplies a business id can read product names/SKUs/packaging of another tenant. The older `enroll/revoke/flag` RPCs do gate on `user_can_access_business`; the new canonical resolver regressed that.
3. **Waiver RLS is scoped to the wrong axis.** `product_identification_waivers` policies use `is_org_member(auth.uid(), organization_id)` while every write path is business-scoped; an org member of a sibling business can read/delete waivers. Should use `user_can_access_business(auth.uid(), business_id)`.
4. **Resolver contract is thinner than the plan promised.** It takes no branch argument, returns no GS1 payload, and on multiple matches silently `LIMIT 1`s with `ORDER BY is_primary DESC` — there is no ambiguity signal, which Phase C explicitly needs ("one not-found / ambiguous-code contract").
5. **Backfill correctness is unverified and unverifiable today.** `product_identifiers` and `product_packaging` are both empty in this environment, so the three backfill steps (legacy `barcode_id`, matching `pack_quantity`, materialising a packaging row) have never executed against real rows. No guard test exists.
6. **No Phase A/B guard tests, no ADR.** The migration ships zero pgTAP/vitest guards; nothing prevents a future migration from reintroducing loose `pack_quantity` reads or the inverse `barcode_id` link. ADR-0090 is already taken by the visual label designer, so the identity ADR needs a new number.
7. **Enrollment queue does not scale.** `useIdentificationQueue` pulls the first 200 active products client-side and only then asks for their level status, so "incomplete identification" is filtered in the browser. On a 50k-SKU catalogue the operator queue is wrong, not just slow — completeness filtering belongs in the projection with keyset pagination.
8. **Test suite could not be executed here** (`vitest` / `@vitejs/plugin-react-swc` are not installed in this sandbox), so the previous engineer's "tests pass" posture is unconfirmed. First action in build mode is to install and run the inventory/scanner/architecture suites and record the result.

## Phase 2 — Revised plan

### Phase A′ — harden the model (must land first)
- Redefine `code_norm` as `upper(btrim(code))` (drop + re-add the generated column, rebuilding the `(business_id, code_norm, kind)` unique constraint that `ProductIdentifiersEditor` upserts against — the existing pgTAP guard `product_identifiers_unique_shape_test.sql` must still pass), and de-duplicate any rows that only differed by case/whitespace before re-adding it. Alternative if the column cannot be rebuilt safely: change every comparison to `lower(btrim(...))`. One direction, everywhere — the mismatch is the bug.
- Gate `resolve_product_identity` and `product_identification_status` on `user_can_access_business(auth.uid(), p_business_id)`; revoke `anon` from the resolver (POS runs authenticated).
- Re-scope waiver RLS to `user_can_access_business` on `business_id`.
- Extend the resolver contract: add `p_branch_id`, a `match_count` / ambiguity indicator, and the parsed GS1 payload (reusing the existing `parseGs1`-equivalent SQL path) so every Phase C consumer shares one not-found / ambiguous / resolved contract.
- Add pgTAP guards: backfill invariants (no identifier whose `pack_quantity` disagrees with its level factor; no identifier bound to another product's level), normalization round-trip, tenant-isolation refusal, and `pos_resolve_barcode` shape/weighted-behaviour parity.

### Phase B′ — finish the workspace properly
- Move completeness filtering into `product_identification_status` (or a companion `product_identification_queue` projection) with keyset pagination; the hook consumes it directly.
- Add a vitest for the level cursor: identified → waived → next level, and the `seq` stale-RPC contract from `mem://features/barcode-enrollment`.

### Phase C — module cutover (unchanged order, now on a sound base)
- **C1** shared client resolver hook over `resolve_product_identity` (single not-found/ambiguous/offline contract).
- **C2** WMS receiving (`ReceivingSessions`) — scanned case posts `qty_in_base_uom` base units; unknown code blocks the line instead of being narrated in a toast.
- **C3** GRN wizard, put-away, picking, cycle/physical counts — same hook, same conversion semantics.
- **C4** purchasing: supplier identifier + packaging level drive received quantity.
- **C5** label printing: `resolveLabelBarcode` / `useLabelPrint` become level-aware (case label prints the case identifier, still refuses rather than falling back to an internal id — ADR-0089 intact).
- Each step ships a regression test plus a guard asserting the module does not read `product_identifiers` directly.

### Phase D — remove the drift
- Drop `product_packaging.barcode_id` and `product_identifiers.pack_quantity` and delete every reader (`ProductPackagingEditor`, `ProductIdentifiersEditor`, `PackagingSelect`, `useProductDetailData`, `productBarcodeImportConfig`, POS barcode settings, offline bridge).
- Delete `useProductsAwaitingBarcode` and migrate `src/test/inventory/enrollment-workflow.test.tsx` onto `useIdentificationQueue`.
- Retire legacy `products.barcode` from the Electron SQLite cache; the offline cache mirrors `product_identifiers`.
- New ADR (next free number, **not** 0090) for the identity contract + architecture guards; update `mem://features/barcode-enrollment` whose invariants still describe the old product-level queue.

### Technical notes
- The `code_norm` change is the only genuinely risky migration (constraint rebuild on a table PostgREST upserts against with `on_conflict` by column name). It runs alone, ahead of everything else.
- Phase A remains additive: no legacy column is dropped until Phase D, so POS scanning keeps working throughout.
- `.lovable/plan.md` is the living ledger; it gets the verification findings above recorded before any new code, and is updated as each step closes.

## Immediate first steps on approval
1. Install dev deps and run inventory/scanner/architecture suites to get a real baseline.
2. Record the verification findings in `.lovable/plan.md` and reopen A/B as A′/B′.
3. Ship the A′ migration (normalization + tenant gating + waiver RLS + resolver contract) with its pgTAP guards.

---

## Verification log — 2026-07-31 (incoming engineer)

Baseline established before any A′ code change:

- `node_modules` was incomplete in the working environment (`vitest`, `@vitejs/plugin-react-swc` missing, TanStack entry unresolved → preview 500). `bun install` restored 1011 packages; the preview entry error and the "cannot run tests" blocker were both environment-only, not code defects.
- `bunx vitest run src/test/inventory src/test/scanner src/test/printing`: **300 passed / 4 failed (312)**.
  - `src/test/printing/label-dispatch-error-taxonomy.test.ts` — 1 pre-existing failure ("both taxonomy branches return `{success:false,error}`, never throw"), unrelated to identification.
  - `src/test/inventory/enrollment-workflow.test.tsx` — worker exits/times out (still bound to the removed-in-D `useProductsAwaitingBarcode` projection). Treated as Phase B′ work, not a new regression.
- Phase A DB objects re-confirmed live (packaging_id, guard trigger, waivers table + RLS, all three RPCs). Phase C confirmed not started (no client reference to `resolve_product_identity`).

### Next action (A′, step 1)
Ship the `code_norm` normalization migration alone: `code_norm` is `lower(code)` while every Phase A function compares `upper(btrim(...))`, so alphanumeric identifiers never match. Dedupe case/whitespace collisions, rebuild the plain `(business_id, code_norm, kind)` UNIQUE constraint (pgTAP `product_identifiers_unique_shape_test.sql` must still pass), then gate `resolve_product_identity` / `product_identification_status` on `user_can_access_business`, revoke `anon`, and re-scope waiver RLS to `business_id`.
