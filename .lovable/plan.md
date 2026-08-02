# Packaging Master (ADR 0105) — authoritative status

Last updated: 2026-08-02 (Phase 8 complete). Source of truth for this workstream.
Reference docs: `docs/adr/0105-packaging-master.md`, `docs/audit/2026-08-02-packaging-master-audit.md`,
`docs/architecture/WMS_MODULE_OWNERSHIP.md`.

## Status board

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `wms_packaging_types` + `_carriers` / `_availability` / `_events` schema | Complete, verified | 34-column master with `packaging_class`, `lifecycle_status`, `row_version`, `tare_weight_kg`; all four tables present |
| 2 | RPC-only writes (`wms_packaging_upsert`, `set_lifecycle`, `archive`, `set_carrier_rule`, `set_availability`) | Complete, verified | all five functions exist, business + `inventory:write` guarded |
| 3 | `suggest_packaging` (3-axis rotation fit, split, dim weight, explainable reasons) + idempotent `assign_packaging_to_pack` | Complete, verified | `suggest_packaging`, `wms_packaging_fits_item`, `wms_pack_cartons.tare_applied_kg` |
| 4 | GS1 / SSCC server-side identity | Complete, verified | `wms_gs1_config`, `wms_sscc_registry`, `wms_sscc_events`, `gs1_check_digit`, `wms_sscc_build/allocate/void/label_payload/mark_printed/resolve` |
| 4.5 | One pack path (desktop + mobile) & privilege hardening | Complete, verified | `MobilePack.tsx` and `PackStation.tsx` both go through `packagingEngine` → `suggest_packaging` / `assign_packaging_to_pack`; client INSERT/UPDATE/DELETE revoked on all packaging + SSCC tables for `authenticated` and `anon` |
| 5 | Handling-unit unification | Complete, verified | `wms_license_plates.packaging_type_id`, propagate trigger, `wms_resolve_carton_scan`, real `pack.carton` scan intent |
| 6 | Hardware scale at seal, label routing, supply consumption | Complete, verified | `wms_packaging_consume` decrements availability, journals `wms_packaging_events`, emits `warehouse.packaging.consumed` / `reorder_needed` |
| 6.1 | Privilege corrections | Complete, verified | `wms_packaging_consume` EXECUTE revoked from `PUBLIC` and `authenticated`; effective-privilege query returned `false` for every client role |
| 7 | Packaging Master workspace UI | Complete | `/warehouse-app/packaging` master/detail workspace (TanStack Table v8), `packagingMaster.ts` RPC-only seam with `row_version` optimistic concurrency, carrier / availability / activity panels, spec form; `/warehouse-app/cartons` redirects; `CartonTypes.tsx` deleted |
| 8 | Decommission legacy | **Complete (this round)** | see below |

### Phase 8 — what shipped (2026-08-02)

Verified empty before the cut: `wms_carton_types` had 0 rows, `wms_pack_cartons.carton_type_id`
had 0 non-null values.

- Dropped `public.wms_carton_types` + `_touch_wms_carton_types_updated_at`.
- Dropped `suggest_carton(uuid, uuid[], numeric[])` and `assign_carton_to_pack(uuid, uuid)`.
- Dropped `wms_pack_cartons.carton_type_id`; `assign_packaging_to_pack` no longer shadow-stamps it.
- Removed the two legacy cases from `wms_replay_guarded_call`, so a device replaying a legacy
  offline intent now fails closed with `WMS_REPLAY_UNSUPPORTED_RPC`.
- Guards rewritten to enforce absence rather than the legacy contract
  (`packaging-master.test.ts` Phase 8 block, `wms-phase12.test.ts`); removed the legacy RPC from
  `wms-phase14.test.ts` and `wms-client-scan-id-unique.test.ts` whitelists and from the
  `pick-pack-dispatch` spec header.
- Docs: ADR 0083 marked partially superseded, ADR 0105 Phase 8 section added, module-ownership
  table gained the packaging-master row.

**Verification run:** `bunx vitest run` on the four touched guard suites — 58/58 passed.
`bunx tsgo --noEmit` — clean. Generated `src/integrations/supabase/types.ts` contains no legacy
symbol.

**Not verified this round:** live browser walkthrough of `/warehouse-app/packaging`.
`LOVABLE_BROWSER_AUTH_STATUS=external_unmanaged`, so the sandbox cannot mint a session for this
project's external Supabase; the route correctly redirects to `/login` unauthenticated. Visual
confirmation must be done by a signed-in human in the preview.

## Currently active phase

None — ADR 0105 phases 1–8 are closed. The packaging master is the sole catalogue, all writes are
server-owned, and the legacy carton surface no longer exists in the database, the generated types,
or `src/`.

## Next milestone

The packaging workstream is finished; the next chronological milestone belongs to the WMS roadmap
that ADR 0105 interrupted (see
`.lovable/plan-warehouse-plan-round-6-verification-resume-2026-07-29.md`):

1. **Phase 4 · UX & error-proofing** — start with `<OutboxTimeline aggregateId />` over
   `business_event_outbox` (six call sites: LPN, wave, manifest, QC inspection, count session,
   receiving session), because typed exception triage and the role dashboards both consume it.
2. Then typed exception triage (`wms_exception_resolution_kind` enum + `due_by` SLA on
   `wms_exceptions`, `wms_resolve_exception` requiring a kind, `ExceptionsInbox` grouped by breach).
3. Then contention toast, `useScanFeedback()`, the two-context realtime Playwright smoke, the three
   role dashboards, and the `e2e/wms/**` de-scaffold audit — in that order.

Deferred, still open, from Phase 5 of that plan: desktop double-submit audit (LoadingBay, PickList,
PackStation, CountSession through the replay dispatcher), trailer no-show → labour reclaim,
`wms-no-orphan-modules.test.ts`, and 3PL billing event coverage.

## Instructions for the next agent

1. **Verify before you build.** Do not trust this file. Re-run
   `bunx vitest run src/test/architecture` and `bunx tsgo --noEmit`, then confirm in the database
   that: `wms_carton_types`, `suggest_carton`, `assign_carton_to_pack` and
   `wms_pack_cartons.carton_type_id` are all absent; `wms_packaging_consume` has no EXECUTE for
   `authenticated`/`anon`/`PUBLIC`; and the packaging tables grant `SELECT` only to
   `authenticated`. Confirm `wms_replay_guarded_call`'s whitelist contains no legacy carton case.
2. **Check the UI end to end** if you have a signed-in session: `/warehouse-app/packaging` list,
   filters, detail tabs, create/edit through the RPC seam, a stale-`row_version` save surfacing the
   `WMS_PKG_STALE` message, and the `/warehouse-app/cartons` redirect.
3. **Then resume chronologically** at Phase 4 §1 above. Do not start unrelated modules, do not
   leave a phase half-built, and replace legacy paths in the same change rather than layering on
   top of them.
4. **Update this file at the end of every implementation** with evidence (query output, test
   output), not assertions.

## Working rules (unchanged)

- One phase at a time; each ends green on `bunx tsgo --noEmit` plus the architecture suite.
- Hard cut, no compatibility shims (no production users).
- Never write `state` / `status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- No new client seam may duplicate `packagingEngine.ts` / `packagingMaster.ts` / `cartonSscc.ts`.
- A feature is not shipped until a real call site consumes it.
