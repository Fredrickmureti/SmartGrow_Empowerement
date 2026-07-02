# Hardware Platform — Wave 9e (Realtime crash fix + 9d.2 architectural reassessment)

## Verified before changing anything

Re-walked the Wave 9b/9c/9d claims. They hold up exactly as the prior audit
docs describe — pages live under `src/apps/platform/hardware/`,
`pos_hardware_configs` is gone, `runtimeCapability()` is wired end-to-end
(main IPC → preload → `HardwareClient.ts:243` → Runtime card), the
single-chokepoint and "hardware not POS-scoped" arch guards exist and pass.
No silent regressions.

## Shipped this wave

### Realtime crash on `/platform/hardware/devices` — fixed

**Symptom:** `cannot add postgres_changes callbacks to realtime:device_assignments:<orgId> after subscribe()`

**Root cause:** `src/hooks/useDeviceAssignments.ts` named its realtime channel
`device_assignments:${orgId}`. The page mounts three live consumers of this
hook on the same client at the same time:

1. `HardwareDevices` page itself
2. `DeviceRegistryCard` → `useHardwareRegistryCrud` → `useDeviceAssignments`
3. `useHardwareProxy` → `useDeviceAssignments`

The Supabase JS client de-duplicates channels by name. The second `supabase.channel(name)`
call returns the already-subscribed channel from the first hook instance, then
`.on('postgres_changes', …)` is appended after `.subscribe()` has already
run → realtime throws.

**Fix:** `src/hooks/useDeviceAssignments.ts` now appends a per-instance UUID
to the channel name (`device_assignments:${orgId}:${uuid}`), so each hook
instance owns a distinct channel. Each `useEffect` cleanup removes its own
channel via `supabase.removeChannel(channel)`.

### Wave 9d.2 (driver code collapse) — re-scoped

The Wave 9d audit deferred a mechanical "collapse renderer drivers to
descriptors" refactor. On a careful read of the code, the premise is wrong
and shipping it as planned would break the browser-fallback path.

**What I found:**

- `src/services/hardware/drivers/EscPosPrinterDriver.ts` etc. are **not**
  duplicates of `electron/hardware/drivers/*`. They are the renderer-side
  runtime for the browser-only path (`browserHardwareAdapter.exec`).
- They build ESC/POS bytes and hand them to `resolveTransport()`, which
  picks `WebUSBTransport`, `LocalAgentTransport`, or `NetworkTransport` at
  runtime. None of that work is done by `electron/hardware/drivers/*`.
- Inside Electron, `HardwareClient.execAny()` short-circuits to
  `execElectron` (`window.pos.hardware.exec`) before
  `browserHardwareAdapter` is ever consulted, so the renderer drivers
  cannot "silently win" over main-process drivers in production. The
  `hardware-driver-duplication` arch guard already enforces the
  `browserFallback: true` flag on every overlapping driver type, which is
  what actually matters.
- Therefore the renderer drivers must keep building ESC/POS bytes and
  calling transports — they are the only runtime when Electron is absent
  (browser preview, mobile-web POS, dev mode). Collapsing them to thin
  descriptors that forward through `hardwareClient.exec(...)` would
  produce infinite recursion (browser → `hardwareClient` → browser).

**Correct invariant** (now memorialized below): the renderer drivers and
main-process drivers are **co-equal implementations of the same protocol**
for different runtimes. The arch guard's job is to enforce the
`browserFallback` flag so the dispatcher picks the right one, not to forbid
the renderer copies from existing.

No code shipped for 9d.2. The Wave 9d audit doc and `.lovable/plan.md`
have been corrected to reflect this.

## Files changed

```text
src/hooks/useDeviceAssignments.ts                          edit  +11 / -2  (per-instance channel name to avoid Supabase channel-name de-dup)
docs/audit/2026-06-05-hardware-wave-9e-realtime-fix.md     new            (this doc)
```

## Validation

Manual: open `/platform/hardware/devices` in the preview, confirm no
`cannot add postgres_changes callbacks after subscribe()` console error
on mount, and confirm the device list still hot-updates when a row is
upserted from another tab.

## What's still open

1. **Wave 9f — Inventory label-print live wiring.** Unchanged, still
   pending UX decision on `src/pages/Products.tsx`.
2. **No live cross-module consumer of `useInventoryLabelPrinter`.** Until
   9f ships, the "hardware is a platform concern" invariant is proven only
   by arch guards and tests.
3. **Wave 9d.2 retired.** The collapse target was based on a misread of
   the renderer-driver role. Nothing to do.
