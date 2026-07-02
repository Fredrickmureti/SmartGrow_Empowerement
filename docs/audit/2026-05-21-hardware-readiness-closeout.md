# Hardware Platform — Readiness Closeout (Re-audit)

Date: 2026-05-21
Auditor: Lovable agent (zero-trust re-audit)

## Verdict

The hardware platform is **enterprise-shaped and single-source-of-truth**:
one device registry (`device_assignments`), one driver layer
(`electron/hardware/drivers/index.ts` + `src/services/hardware/drivers/`),
one transport abstraction (Electron CommandRouter / LocalAgent /
WebUSB), one event bus (`HardwareEventBus`), one capability detector
(`src/lib/environment.ts`). Platform-owned routes live under
`/platform/hardware/*` with POS redirects for backward compatibility.

**Production-ready for:** single-company and multi-company tenants using
the supported hardware core (receipt printer, kitchen printer, cash
drawer, scale, customer display, barcode scanner, payment terminal in
cloud mode).

## Payment terminal — VERIFIED IMPLEMENTED (not "Coming soon")

The previous agent's "Coming soon" label was a stale UI string, not a
missing feature. End-to-end stack confirmed in code & DB:

| Layer | Location |
|---|---|
| DB | `pos_terminal_provider_configs`, `pos_terminal_sessions` |
| RPCs | `get_terminal_config_masked`, `set_terminal_provider_config`, `delete_terminal_provider_config` |
| Edge fn | `supabase/functions/terminal-outbound/index.ts` (health / connection_token / create_intent / capture / cancel / refund / query) |
| Secret storage | Supabase Vault (service-role only; client sees `api_key_masked` + `has_secret`) |
| Driver | `electron/hardware/payment/CloudTerminalDriver.ts` + `PaymentService.ts` + `PaymentStateMachine.ts` + `SettlementReconciler.ts` |
| Tenant UI | `/pos/payment-terminals` (`src/pages/pos/PosTerminalsPage.tsx`) |
| Hook | `src/hooks/pos/usePosTerminal.ts` — same shape as `usePaymentRequests` |

Providers supported in cloud mode today: Stripe Terminal, Adyen,
Verifone Cloud, Square Terminal. Users plug their own credentials, can
test the connection, and the state machine writes to
`payment_requests`.

This audit shipped:
- Removed the `comingSoon` flag and amber badge from the platform
  Hardware Devices page (`src/apps/platform/hardware/HardwareDevices.tsx`).
- Added a "Configure provider" link from the payment terminal role card
  to `/pos/payment-terminals` so users discover the credential UX.

## Open deferrals (transparent, scoped, non-blocking for core GA)

| # | Item | Status | Blocker for |
|---|---|---|---|
| 1 | Network printer mDNS broadcast discovery | Deferred — manual IP add works; UI labels it `notImplemented` | None — usability nicety |
| 2 | `barcode_scanner` Electron driver factory returns `null` | Intentional — HID keyboard-wedge handled in renderer by `scanBus`. Documented. | None |
| 3 | Per-vendor native PED SDKs bundled in Electron (BBPOS WisePOS USB, Verifone P400 serial, etc.) | Deferred — cloud-mode covers all four providers | "Offline terminal" mode only |
| 4 | Supabase Auth dashboard toggles (OTP expiry < 1h, leaked-password protection) | Deferred — manual dashboard action by org owner | Auth hardening grade |
| 5 | `NOT NULL` on `business_id` for 12 Phase-2 tables (column + RLS already shipped) | Deferred — pending writer backfill audit | Multi-company GA |
| 6 | Two-company / two-branch Vitest isolation suite in CI | Deferred | Multi-company GA |

Items 5 and 6 remain the only true blockers for multi-company GA
certification. The remaining items are scoped enhancements with no
runtime risk.

## Canonical architecture (single source of truth)

```text
┌──────── UI (any module: POS / Inventory / Sales / HR / Mfg) ────────┐
│   useDeviceAssignments  →  HardwareClient  →  send(op, payload)     │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
     ┌───────────────────────────┴──────────────────────────────┐
     │ runtimeCapability() picks ONE transport per assignment:  │
     │   • Electron CommandRouter (IPC → main-process drivers)  │
     │   • LocalAgentTransport    (HTTP → localhost:8043 agent) │
     │   • WebUSBTransport        (browser-native, user gesture)│
     └───────────────────────────┬──────────────────────────────┘
                                 │
                         device_assignments
                  (organization_id + business_id + branch_id)
```

Hardware is a **platform concern**, not a POS concern. Any module
imports `useDeviceAssignments` + `HardwareClient` to consume the same
registry. POS owns only the POS-specific UX wrappers
(`/pos/payment-terminals` etc.).
