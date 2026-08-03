# Dispatch — Verification Verdict + Phase C (Proof of Dispatch)

## Phase 1 — verification of the previous engineer's claims

I checked live database function bodies and the migration history rather than trusting
the status table.

**Phase A (departure relieves inventory) — genuinely shipped.** Confirmed in the live
`wms_transition_manifest` body: the `dispatched` edge loops every loaded carton, skips
plates already `shipped` (idempotent), calls `wms_lpn_dispatch` in the same transaction
with no exception wrapper (relief failure rolls back the dispatch), emits
`warehouse.carton.shipped` per carton and returns `lpns_relieved`. Scan-out shortage and
empty-manifest guards run at both close and dispatch. `close_loading_manifest` and
`dispatch_loading_manifest` survive only as delegates; a single `open_loading_manifest`
signature remains. pgTAP and Vitest guards exist.

**Phase B (one outbound spine) — genuinely shipped.** The migration adds
`wms_loading_manifests.delivery_note_id` and `delivery_notes.manifest_id`;
`wms_manifest_bridge_delivery_notes` exists in the database, resolves the notes the load
physically carries and dispatches each through the existing `dispatch_delivery_atomic`
RPC (no second write path, existing notification trigger still fires);
`_wms_manifest_after_dispatch` invokes it from the FSM. ADR-0109 records both decisions.

**Two gaps found while verifying, folded into the work below:**
- The generated `src/integrations/supabase/types.ts` does not yet contain
  `delivery_note_id` / `manifest_id`, so no frontend surface can read the new spine — the
  link is currently backend-only and invisible to Sales and the Loading Bay.
- `LoadingBay` still polls shortages every 15s on `["wms-manifest", …]` while realtime
  publishes `["wms-loading-manifest"]` (the known Phase F key drift), and neither dispatch
  surface shows the linked delivery note.

Verdict: resume at **Phase C**; no Phase A/B rework needed.

## Phase C — Proof of dispatch

Today departure records only `dispatched_at` / `dispatched_by`. Nothing captures who took
custody. This phase makes departure evidentiary.

**Database**
- New `public.wms_dispatch_proofs`: `manifest_id`, `seal_number`, `driver_name`,
  `driver_id_ref`, `signature_url`, `photo_urls[]`, `gps_lat/lng`, `captured_at/by`,
  org/business/branch scope, `is_sample_data`. GRANTs, then RLS, then policies, in one
  migration.
- `wms_capture_dispatch_proof(...)` `SECURITY DEFINER` RPC as the only write path; it also
  stamps the manifest's trailer visit `seal_out`, so the seal on the truck and the seal on
  the paperwork cannot diverge.
- A business setting (`dispatch_requires_proof`) gates enforcement. When on,
  `wms_transition_manifest` refuses the `closed → dispatched` edge without a proof row,
  raising `WMS_PROOF_REQUIRED` — enforced in the FSM, never in the client.

**UI**
- Loading Bay: a "Seal & release" step before dispatch — seal number (scannable), driver
  name/ID, signature via the existing `SignatureCanvas`, photos into the existing private
  `delivery-proofs` bucket. Dispatch stays blocked until proof exists when required, and
  the linked delivery note is surfaced on the manifest.
- Mobile dispatch: the same capture, handheld-first — scan seal, sign on glass, camera,
  single confirm.
- No new upload or signature primitives, no new libraries.

**Tests**
- pgTAP: dispatch blocked without proof when required; allowed when not; capture is
  idempotent; seal propagates to the trailer visit.
- Architecture guard: RPC-only proof writes, no client-side-only enforcement.

## Carried forward (unchanged, in order)

- **D — carrier abstraction:** `carrier_kind`, `carrier_services`, manifest
  `tracking_number` / `tracking_url` allocated by `wms_allocate_tracking_number`,
  adapter-shaped so a live carrier API is a later plug-in. Lands with an ADR.
- **E — dispatch documents:** register `bill_of_lading`, `dispatch_manifest`,
  `packing_list`, `carrier_label` fetchers in `generate-document`; Dispatch requests,
  never renders. Coverage matrix rows plus a wiring guard.
- **F — control tower and live-ness:** fix the `wms-manifest` / `wms-loading-manifest` key
  drift, add `wms_trailer_visits` and `wms_yard_slots` to the realtime publication, delete
  both 15s polls, rebuild `OutboundDashboard` as one drill-down control tower (late,
  blocked, short-scanned, awaiting seal, free docks, waiting trucks). Only here consider a
  timeline library for dock scheduling.

## Standing rules

Schema through the migration tool; every mutation in a `SECURITY DEFINER` RPC with
`row_version` optimistic locking (ADR-0101); GRANTs → RLS → policies in the same
migration; each phase closes with architecture tests plus pgTAP invariants; Dispatch
orchestrates only — Inventory owns stock, Warehouse owns pick/pack, Finance owns revenue,
the Document Platform owns rendering.

---

## Closed — 2026-08-03

All phases delivered; this plan is closed.

- **A — dispatch relieves inventory:** verified shipped (ADR-0109).
- **B — one outbound spine:** verified shipped (ADR-0109). The generated
  `types.ts` gap noted during verification has since regenerated and now carries
  `delivery_note_id` / `manifest_id`; the Loading Bay surfaces the linked delivery notes.
- **C — proof of dispatch:** `wms_dispatch_proofs`, `wms_capture_dispatch_proof`
  (also stamps the trailer visit `seal_out`), `wms_manifest_proof_status`, FSM
  enforcement via `WMS_PROOF_REQUIRED` gated on `warehouses.require_dispatch_proof`.
  Captured from the Loading Bay and, through the offline queue, the RF handheld. The
  handheld no longer re-derives the verdict; both shells read the server's.
- **D — carrier abstraction:** `carriers.carrier_kind`, `carrier_services`, manifest
  `carrier_service_id` / `tracking_number` / `tracking_url`, allocated idempotently by
  `wms_allocate_tracking_number` and surfaced in the Loading Bay. ADR-0110.
- **E — dispatch documents:** `bill_of_lading`, `dispatch_manifest`, `packing_list`,
  `carrier_label` registered in `generate-document`; requested from the bay via
  `DispatchDocumentsMenu` → `printDocument`. Coverage matrix rows plus a wiring guard.
- **F — control tower and live-ness:** `wms-manifest*` key drift fixed,
  `wms_trailer_visits` / `wms_yard_slots` published and subscribed, both 15s polls
  deleted, `OutboundDashboard` gained late departures, awaiting seal, waiting trucks and
  free yard slots. No timeline library was needed.

Tests: `supabase/tests/wms_dispatch_proof_and_carrier_test.sql`,
`src/test/architecture/wms-dispatch-proof-and-liveness.test.ts`,
`src/test/printing/dispatch-documents-wiring.test.ts`.
