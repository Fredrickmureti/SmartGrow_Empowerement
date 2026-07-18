# WMS Production-Readiness Roadmap — Phases 14–22

Each gap from the readiness audit becomes its own phase with a clear
entry criterion, deliverables, verification, and explicit non-goals.
No phase silently expands another. Phases ship in order; later phases
assume earlier ones landed.

Legend: **[ARCH]** touches architecture guards · **[DB]** migrations ·
**[UI]** desktop or mobile screens · **[OPS]** docs/runbooks ·
**[TEST]** test-only.

---

## Phase 14 — End-to-end integration harness  [TEST][ARCH]

**Problem:** No test proves receipt → dispatch works end-to-end. Any
cross-phase regression ships silently.

**Deliverables**
1. Deterministic seed migration (`is_sample_data = true`): 1 warehouse,
   3 zones/bins, 2 products with lots, 1 carrier, 1 dock, 1 carton type,
   1 QC hold reason, 1 labour standard per task type.
2. Playwright suites:
   - `e2e/wms/` — desktop flows: `receive`, `putaway`, `wave`,
     `pick-pack-dispatch`, `qc`, `count`.
   - `e2e/wm/` — mobile offline-queue flow: toggle offline → enqueue →
     toggle online → assert drain + server RPC landed.
3. `wms-phase14.test.ts` architecture guard: every named spec file
   exists and covers the phase it names.

**Non-goals:** load/concurrency, CI scheduling, new UI.

**Done when:** full E2E green locally against the seed; guard passes.

---

## Phase 15 — Concurrency & contention hardening  [DB][TEST]

**Problem:** Two pickers on one wave, two packers on one carton, dock
double-booking are unproven. Row locks likely hold but nothing asserts
it.

**Deliverables**
1. Postgres-level contention tests under `supabase/tests/wms/`
   exercising each critical RPC pair with `pg_isolation` style
   transactions:
   - `claim_pick_task` × 2 sessions
   - `open_pack_carton` × 2 sessions
   - `schedule_dock_appointment` overlapping windows
   - `assign_carton_to_pack` racing with `seal_pack_carton`
2. Any RPC that fails the test gets an explicit `SELECT ... FOR UPDATE`
   or a unique partial index — no advisory locks unless justified in
   ADR.
3. ADR 0080 — "WMS concurrency invariants": lists every RPC and its
   locking strategy in one table.

**Non-goals:** load testing (Phase 20), UI changes.

**Done when:** every listed race test is red without the fix, green
with it; ADR merged.

---

## Phase 16 — Outbox consumer proof  [ARCH][DB]

**Problem:** `business_event_outbox` has publishers but no real
consumer. ADR 0076 follow-up.

**Deliverables**
1. Migrate **one** existing consumer off direct triggers to subscribe
   to `stock.movement.dispatched` — pick whichever is smallest between
   Finance COGS JE and replenishment.
2. Consumer worker lives as a Supabase edge function
   (`outbox-consumer-<name>`), cron-scheduled every minute via
   `pg_cron` + `pg_net`.
3. Idempotency key check on the consumer side using
   `business_event_outbox.event_id`.
4. Architecture guard: the old direct-trigger path is deleted, not
   dual-written.

**Non-goals:** migrating all consumers, new event types.

**Done when:** consumer processes seeded events; old trigger dropped;
guard blocks reintroducing it.

---

## Phase 17 — Observability & SLOs  [UI][DB][OPS]

**Problem:** Ops teams can't see outbox lag, mobile queue depth, task
cycle time, or RPC error rates.

**Deliverables**
1. Views/RPCs (all `SECURITY DEFINER`, role-gated):
   - `wms_outbox_lag` — oldest pending event age per event_type.
   - `wms_task_cycle_time` — actual vs labour standard per task_type.
   - `wms_rpc_error_rate` — from `business_event_outbox` failed rows.
   - `wms_mobile_queue_depth` — reported by mobile via heartbeat RPC.
2. New page `/warehouse-app/ops/health` — 4 tiles + drilldowns.
3. Mobile heartbeat: `MobileWarehouseLayout` posts queue depth every
   60s via `enqueue('report_mobile_queue_depth', ...)`.
4. Runbook `docs/wms/observability.md` — what each metric means, alert
   thresholds, first-response actions.

**Non-goals:** external APM (Datadog etc.), paging integration.

**Done when:** dashboard populated against seeded data; heartbeat lands.

---

## Phase 18 — Printing & label integration audit  [OPS][UI]

**Problem:** LPN labels, pack slips, BOL, load manifests not audited
against the hardware/print router (ADR 0026).

**Deliverables**
1. Audit doc `docs/wms/printing-audit.md`: for each artefact (LPN, pack
   slip, BOL, load manifest, put-away label) — template location,
   render path, print router surface, tested on which hardware.
2. Fill gaps: any missing ZPL template goes under
   `src/features/printing/templates/wms/` following existing patterns.
3. Print-preview surface wired for each artefact on its owning desktop
   page (Pack station, Loading manifest, Receiving).
4. Architecture guard: no raw `window.print()` and no raw ZPL outside
   `src/features/printing/` (existing eslint rules already cover this
   — extend rule allowlist review, don't reintroduce shims).

**Non-goals:** new hardware drivers, new print protocols.

**Done when:** every artefact renders through the router with a linked
template; audit doc merged.

---

## Phase 19 — ASN-line scan-driven receive on mobile  [DB][UI]

**Problem:** Deferred item. Any ASN-based customer hits this on day 1.

**Deliverables**
1. New RPC `receive_asn_line_scan(asn_id, gtin, qty, lot?, serial?)`
   with idempotency key `wms.asn_line:<asn_line_id>:<scan_seq>`.
2. Mobile page `MobileReceive` gains an ASN mode when the scan resolves
   to an ASN header instead of a blind receipt.
3. Guard `wms-phase19.test.ts`: route wired; RPC flows through
   `enqueue`.

**Non-goals:** desktop ASN editor changes, EDI ingestion.

**Done when:** mobile flow accepts ASN scans against a seeded ASN;
mismatched GTIN raises a validation error surfaced in the queue drawer.

---

## Phase 20 — Runbooks & operator recovery docs  [OPS]

**Problem:** Code supports recovery scenarios; ops docs don't exist.

**Deliverables** — one runbook per scenario under `docs/wms/runbooks/`:
1. Stuck offline queue on a device (inspect drawer, retry, discard,
   reset IndexedDB).
2. Outbox replay for a specific event_type window.
3. Cancelling a mid-flight wave (which RPC, side effects on picks).
4. Correcting a mis-scanned LPN post-seal.
5. Dock appointment double-book recovery.
6. Cycle count variance approval path.

Each runbook: symptom → diagnosis query → resolution RPC → validation
query. No prose without a copy-pasteable SQL/RPC.

**Non-goals:** in-app runbook viewer.

**Done when:** all six merged and linked from
`docs/wms/observability.md`.

---

## Phase 21 — Security & RLS re-audit  [DB][TEST]

**Problem:** Security memory + RLS review hasn't run since Phase 13.1
added mobile routes and new RPCs.

**Deliverables**
1. Run `security--run_security_scan`; triage every finding on `wms_*`
   tables and RPCs added since Phase 10.
2. Confirm every new `SECURITY DEFINER` RPC pins `search_path` and
   scopes writes to `auth.uid()`'s branch.
3. Confirm every `wms_*` table has GRANTs matching its RLS policies —
   drop `anon` where every policy uses `auth.uid()`.
4. Update `@security-memory` with the current WMS posture.

**Non-goals:** rewriting auth, cross-module RLS work.

**Done when:** scan clean or every finding has a documented ignore
with justification.

---

## Phase 22 — Pilot go-live checklist  [OPS]

**Problem:** No single doc tells a pilot customer "you are ready".

**Deliverables** `docs/wms/pilot-checklist.md`:
- Data prep (locations imported, GTINs registered, carton types,
  labour standards).
- User prep (roles assigned, mobile devices installed, printers
  paired).
- Cutover plan (freeze window, opening-balance count, first receipt
  supervised).
- Rollback plan (how to disable mobile routes, revert to prior WMS if
  one exists).
- Success metrics after 2 weeks (using Phase 17 dashboards).

**Non-goals:** multi-site GA — that gates on Phase 20 + Phase 15
running clean in the pilot for 30 days.

**Done when:** checklist merged and reviewed with one design partner.

---

## Deferred beyond this roadmap

- Multi-site GA readiness (gated on pilot outcomes).
- PWA manifest split for `/wm` (cosmetic; documented deferral).
- ADR 0084 (deferred with intent).
- External APM/paging integration.
- Load testing at 100+ concurrent operators.

## Sequencing rule

Do not start Phase N+1 until Phase N's `Done when` is satisfied. Phases
17 and 18 can run in parallel if two contributors are available;
everything else is strictly sequential because each builds on the last.
