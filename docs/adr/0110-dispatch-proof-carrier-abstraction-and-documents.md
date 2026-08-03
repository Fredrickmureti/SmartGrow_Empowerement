# ADR-0110 — Proof of dispatch, carrier abstraction, dispatch documents, and a live control tower

Status: Accepted
Date: 2026-08-03
Extends: ADR-0101 (WMS domain/event catalog), ADR-0102 (LPN handling units),
ADR-0109 (dispatch relieves inventory; the manifest is the outbound spine),
ADR-0086 / ADR-0088 (single print entry point, policy-resolved transport).

## Context

After ADR-0109 the physical departure was ledger-correct and linked to the sales
stack, but the departure itself was still thin. Four gaps remained:

1. **Departure recorded no custody.** Only `dispatched_at` / `dispatched_by`. Nobody
   could answer "who took the goods, under which seal, and can they prove it?".
2. **Dispatch assumed our own truck.** `carriers` was a picklist with a name. There was
   no notion of a carrier *kind*, no service level, and no tracking identity, so a
   parcel load and a full trailer were indistinguishable to the system.
3. **No dispatch paperwork.** No bill of lading, no load sheet, no packing list, no
   carrier label — the one thing the driver actually needs in hand.
4. **The boards lied for up to 15 seconds.** The Loading Bay and the Yard Board polled;
   worse, the Loading Bay registered its queries under `wms-manifest*` while the realtime
   channel only invalidated `wms-loading-manifest*`, so realtime never reached it.

## Decision

**Proof of dispatch is evidence, and the server owns the rule.** `wms_dispatch_proofs`
holds one row per manifest (seal, driver, driver ref, signature, photos, GPS, captured
by/at). `wms_capture_dispatch_proof` is the only write path; it also stamps the trailer
visit's `seal_out`, so the seal on the truck and the seal on the paperwork cannot
diverge. A per-warehouse setting, `require_dispatch_proof`, gates enforcement, and the
enforcement itself lives in `wms_transition_manifest`: without a satisfying proof row the
`closed → dispatched` edge raises `WMS_PROOF_REQUIRED`. Clients read the verdict from
`wms_manifest_proof_status` and never re-derive it — the desktop button and the handheld
both mirror the server. The RF shell captures through the offline queue, so a driver in a
dead zone still takes custody evidence.

**Carrier behaviour is a kind, and tracking identity is allocated, never typed.**
`carriers.carrier_kind` (`parcel | ltl | ftl | courier | own_fleet`) plus a
`carrier_services` table (service code, transit days, tracking URL template) describe how
a load moves. `wms_allocate_tracking_number(manifest, service)` is the only writer of
`tracking_number` / `tracking_url`; it is idempotent (an allocated manifest returns the
same number), it degrades to the manifest code for own-fleet moves, and it is
adapter-shaped: swapping the internal mint for a live carrier API changes the function
body and nothing else.

**Dispatch requests documents; it never renders them.** Four artifacts —
`bill_of_lading`, `dispatch_manifest`, `packing_list`, `carrier_label` — are registered
fetchers in `generate-document` over one manifest bundle, and are requested from the
Loading Bay through `printDocument` with an intent (A4 for paperwork, `label` for the 4x6
thermal label). The label prints the *already allocated* tracking number; rendering never
mints one, so a label can never disagree with the manifest.

**The control tower is event-driven.** `wms_trailer_visits` and `wms_yard_slots` joined
the realtime publication; the `wms-manifest*` / `wms-loading-manifest*` key drift is
fixed in `useWmsRealtimeSync`; every 15s poll on the Loading Bay and Yard Board is gone.
`OutboundDashboard` gained the kerb-side view a shipping supervisor actually acts on:
late departures, loads awaiting seal and signature, trucks waiting for a dock, free yard
slots.

## Consequences

- A dispatched load is defensible: seal, driver, signature, time, and location, captured
  identically on the desktop bay and the handheld, offline included.
- Adding a real carrier integration is a function-body change behind an existing RPC, not
  a new write path or a schema migration on the manifest.
- Dispatch paperwork follows the same policy resolution as every other document in the
  platform; the Document Platform still owns rendering.
- Enforced by `supabase/tests/wms_dispatch_proof_and_carrier_test.sql`,
  `src/test/architecture/wms-dispatch-proof-and-liveness.test.ts`, and
  `src/test/printing/dispatch-documents-wiring.test.ts`.
