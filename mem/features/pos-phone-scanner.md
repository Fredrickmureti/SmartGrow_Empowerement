---
name: POS phone-as-scanner
description: Phone joins a register via QR-pairing, decodes barcodes locally, broadcasts strings only. Terminal stays authoritative over the cart.
type: feature
---

## Invariants

1. The phone NEVER writes to the cart, NEVER calls `pos_resolve_barcode`, NEVER reads stock. It only broadcasts `{ code, seq, decoded_at }` on the per-register Supabase Realtime channel `pos:scan:<register_id>`. **Why:** keeps the desktop terminal the single authority and avoids cross-device cart drift.
2. Pairing tokens (`pos_scanner_pairings`) are single-use and expire in 60 seconds. `pos_create_scanner_pairing` mints; `pos_claim_scanner_pairing` redeems. Both RPCs require the caller to have an active `user_roles` row in the register's organization.
3. Camera scans enter the terminal via `usePOSScannerChannel` → `scanBus.emit({ source: 'camera' })`. The existing terminal subscriber (`POSTerminal.tsx`) handles resolve + cart-add identically to keyboard-wedge scans — no parallel pipeline.
4. `scanBus` enforces a 250ms cross-source dedupe keyed by `code`, so a barcode scanned simultaneously by a wedge gun and a paired phone only adds one cart line.
5. Phone-side decoder priority: native `BarcodeDetector` first (Chrome Android, Edge, Safari 17+); ZXing dynamic import as Safari/iOS fallback. Local 400ms dedupe on the phone prevents multi-frame spam.
6. The `pos:scan:<register_id>` channel is a Supabase Realtime **private** channel. RLS on `realtime.messages` (policy `pos_scan_channel_*`) calls `public.can_access_pos_scan_channel(topic)` which enforces: authenticated, active `user_roles` in the register's org, AND branch access via `user_can_access_branch`. Both pairing RPCs apply the same branch-access check, closing the cross-branch pairing hole. **Why:** without RLS, any anon-key holder could inject scans into a live cart.
7. Phones broadcast a stable `device_id` (sessionStorage UUID) used as the presence key and as the seq-dedupe map key in `usePOSScannerChannel`. **Why:** two phones paired to the same register must not share a seq counter — the old literal `"phone"` caused one phone's scans to be silently dropped.
8. Terminal mirrors `scanFeedbackBus` (`ok | weighted | unknown`) back to the phone as `event:'ack'` broadcasts. The phone plays a green beep for accepted scans and a red beep + vibrate pattern for unknown/error. **Why:** enterprise scanners always confirm — without ACK the cashier can't tell from across the counter whether a scan landed.
9. `pos_revoke_scanner_pairing(register_id)` (SECURITY DEFINER) sets `revoked_at` on active pairings; the terminal also fires a `revoke` broadcast so the phone stops the camera and shows "Disconnected by terminal". **Why:** operational kill-switch without closing the shift.
10. `pg_cron` job `pos-scanner-pairings-purge` deletes pairings older than 24 h nightly. Direct INSERT/UPDATE/DELETE on `pos_scanner_pairings` is blocked by RESTRICTIVE RLS policies — only the SECURITY DEFINER RPCs may mutate the table.
11. Phone reads the pairing token from the URL fragment (`/pos/scan#<token>`) first, falling back to the path param for backward compatibility. Fragments are not sent to the server or logged by referrer headers.
12. Phone pauses the camera + releases wake-lock on `document.visibilitychange → hidden`, and exponential-backoffs re-subscribes on Realtime `CHANNEL_ERROR`/`CLOSED`/`TIMED_OUT`.
## ERP-wide extension (2026-05-18)

13. The same pairing primitive now serves non-POS surfaces via `scanner_sessions` / `scanner_session_pairings` (topic `scan:session:<id>`). `<BarcodeInputField>` + `<ScannerPairingButton>` are the only sanctioned consumer pattern outside POS. The phone reads the URL fragment first, then path param.
14. `scanRouter.wasConsumed(event)` MUST be checked by every legacy `scanBus.on` consumer (POSTerminal cart, ReturnDialog). Without it a focused field plus a bus consumer mounted on the same screen double-dispatch the same scan.
15. `scanFeedbackBus` is now source-tagged (`field | terminal`). `usePOSScannerChannel` mirrors only `terminal` feedback back to the paired phone — a barcode typed into a Products form does not beep the cashier-side phone.
16. `<BarcodeInputField>` forwards `branchId` to `pos_resolve_barcode`. Pass the active branch where available so multi-branch tenants get accurate uniqueness hints.
