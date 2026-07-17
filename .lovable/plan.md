
# Phase 13 — RF / Mobile Operator Shell

Goal: give warehouse operators a phone/handheld experience — one big scan target per step, huge tap targets, thumb-reach layout, offline-tolerant task queue — instead of forcing them onto the desktop pages. This is the single biggest enterprise-readiness gap identified in the prior audit.

## Scope this phase

**In:** mobile shell + four highest-volume flows (receive, putaway, pick, cycle-count-execute) + offline task queue + one architecture guard + one ADR.

**Out (deferred to Phase 13.1+):** pack/dispatch mobile, QC mobile, voice picking, Capacitor packaging for App/Play Store, push notifications, hardware RF-gun ANSI-key bindings.

## Delivery mode

Installable PWA (manifest + guarded service worker for HTML NetworkFirst + hashed-asset CacheFirst). Works on any modern Android/iOS device with a camera — no store submission. Capacitor wrapping is a future phase if the user wants native camera/scanner SDKs.

## What ships

### 1. Mobile shell (new)
- New route tree `/wm/*` with its own compact layout (`MobileWarehouseLayout`): fixed top bar (badge, task type, cancel), scrollable content, fixed bottom action bar. No sidebar. Locked to portrait CSS width.
- `MobileHome`: shows operator's assigned open tasks grouped by type, tap-through to the right flow. Reads `wms_tasks` filtered by `assignee_id = auth.uid()` + `state in ('ready','in_progress')`.
- Auto-redirect from `/wm` on mobile viewports; desktop users can still open it directly.

### 2. Four operator flows (each is one page, scan-driven, step-machine)

| Route | Flow | RPCs used (all already exist) |
|---|---|---|
| `/wm/receive/:appointmentId` | Scan dock → scan ASN barcode → scan product/lot → enter qty → confirm line → next | existing `receive_grn_line`, `close_grn` |
| `/wm/putaway/:taskId` | Scan LPN → scan source bin → scan dest bin → confirm | existing `start_putaway_task`, `complete_putaway_task` |
| `/wm/pick/:taskId` | Scan bin → scan product/lot → enter qty → confirm; loop until wave line done | existing `start_pick_task`, `pick_line`, `complete_pick_task` |
| `/wm/count/:sessionId` | Scan bin → scan product → enter qty → next line | existing `record_count_line`, `close_count_session` |

Every step reuses `BarcodeInputField` (already present, GS1-aware). Camera scan uses the browser `BarcodeDetector` API when available with `InAppQrScanner` as fallback. No new hardware code.

### 3. Offline task queue

- New client-side module `src/apps/warehouse-mobile/offlineQueue.ts` — IndexedDB-backed FIFO of `{ rpc, args, idempotency_key, enqueued_at }`.
- Every mobile flow wraps its RPC call in `enqueue(...)` which either fires immediately when `navigator.onLine` or defers.
- Drain worker retries with exponential backoff. Every RPC already carries a natural idempotency key (`wms.<entity>:<id>:<state>`), so replays are safe.
- UI indicator in the mobile top bar: green (synced) / amber (N queued) / red (queue error). Tap opens a drawer to inspect + manually retry.
- Draining runs regardless of the current route so a queued action from `/wm/pick` completes even after the operator has moved to `/wm/putaway`.

### 4. PWA installability

- `public/manifest.webmanifest` + head tags + icons (128, 192, 512, maskable).
- Guarded service-worker registration wrapper (never registers in Lovable preview, iframe, `?sw=off`). Uses `vite-plugin-pwa` with `generateSW`, `injectRegister: null`, HTML NetworkFirst, hashed assets CacheFirst, `/~oauth` excluded.

### 5. Architecture guard `src/test/architecture/wms-phase13.test.ts`

- `/wm` routes are wired in `src/apps/warehouse-mobile/routes.tsx` and each declared route file exists.
- Mobile flows do not `.from(...).update|insert|delete` any `wms_*` table — they must call RPCs through `offlineQueue`.
- `offlineQueue.enqueue` is the only place `supabase.rpc` is called from within `src/apps/warehouse-mobile/**` (single chokepoint = single retry policy).
- `MobileWarehouseLayout` is the only layout used by any `/wm/*` route.
- SW registration wrapper contains all required guards (preview host prefixes, iframe check, `?sw=off`).

### 6. ADR `docs/adr/0084-wms-rf-mobile-shell.md`

Charter: mobile shell is a **presentation layer** over the same RPCs the desktop calls — no new server surface, no new tables. Offline is queue-and-replay, not local-first — inventory truth still lives in Postgres. Idempotency keys make the replay safe.

## Not doing this phase

- No new tables, no new RPCs, no migration. If we discover a gap during build (e.g. `receive_grn_line` needs an ASN-scan variant) we scope a follow-up rather than expand this phase.
- No Capacitor / App Store packaging.
- No push notifications.
- No pack/dispatch/QC mobile screens (Phase 13.1).
- No voice picking / pick-to-light (Phase 15 candidate).

## Definition of done

- `/wm/*` mobile pages functional against real data on a phone-sized viewport.
- Offline queue: kill network in devtools → operator can still complete a pick → restore network → RPC fires, wave state advances, no duplicates.
- PWA installable in a published build (not in Lovable preview).
- `wms-phase13.test.ts` green.
- ADR 0084 committed.
- `.lovable/plan.md` updated: Phase 13 shipped, Phase 13.1 (pack/QC mobile) promoted to START HERE NEXT.

## Technical details

- Route tree lives in `src/apps/warehouse-mobile/`, mounted from `App.tsx` at `/wm` so it can render outside `WarehouseLayout`.
- Reuses `src/components/scanner/BarcodeInputField.tsx` for keyboard-wedge scanners and `InAppQrScanner.tsx` for camera scans — no duplicate scanner code.
- IndexedDB via `idb` (already used elsewhere? — if not, ~2KB dep; verified in Phase 1 of build).
- Service worker follows the Lovable PWA skill: `vite-plugin-pwa` with `generateSW`, guarded single wrapper, `/~oauth` exclusion.
- Idempotency: mobile flows never mint new keys; they pass through the keys the RPCs already stamp (`wms.pick_task:<id>:<state>`, etc.), so replays are naturally deduplicated by the outbox.

---

## Phase 13 — SHIPPED

- `/wm/*` mobile route tree mounted from `App.tsx` behind `AppInstalledGate("warehouse")`.
- Pages: `MobileHome` (my tasks + open receipts + open count sessions), `MobilePutaway`, `MobilePick`, `MobileCount`, `MobileReceive`.
- `MobileWarehouseLayout` — fixed-viewport shell with back nav, `QueueIndicator` chip, sticky bottom action bar.
- Offline queue at `src/apps/warehouse-mobile/offlineQueue.ts` — IndexedDB-backed FIFO via `idb`; `enqueue()` is the single chokepoint for `supabase.rpc` inside the mobile shell; drain loop wakes on `online` event + 8 s tick; per-row retry/discard from the queue drawer.
- PWA already wired via existing `vite-plugin-pwa` config (verified). No new SW code needed.
- Guard `src/test/architecture/wms-phase13.test.ts` — 6/6 green. Enforces: no direct `supabase.rpc` in mobile pages, layout uniformity, route wiring, drain-loop presence.
- Deferred (Phase 13.1 START HERE NEXT): pack/dispatch/QC mobile screens; per-scan ASN variant of `receive_goods_to_wms` if operator-side ASN scanning is requested; installable manifest polish (mobile-specific icons + `/wm` `start_url`).
