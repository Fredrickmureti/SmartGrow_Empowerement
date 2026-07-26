# AccrualFlow Edge — Hardware Runtime

**Status:** Phase 2 (relay transport + hardened localhost runtime). Formerly `pos-hardware-agent`.
See `.lovable/plan.md` for the full architecture roadmap.

A signed, loopback-bound runtime that bridges the AccrualFlow ERP to
local hardware: receipt printers (ESC/POS), label printers (ZPL), USB
devices, biometrics, and — in later phases — scales, drawers, EFT
terminals, scanners, customer displays, RFID, cameras.

## What Phase 1 adds

- **Product identity**: reports as `accrualflow-edge` on `/health`.
- **DNS-rebinding defense**: rejects requests whose `Host` header is
  not `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`.
- **Private Network Access**: emits `Access-Control-Allow-Private-Network: true`
  on preflight so `https://www.accrualflow.systems` can reach the
  loopback listener under Chrome's PNA rules.
- **Production origin allowlisted**: `https://www.accrualflow.systems`
  (+ apex) baked into the default `AGENT_ALLOWED_ORIGINS`.
- **Loopback bind**: the listener binds `127.0.0.1` explicitly instead
  of `0.0.0.0`; the agent is not reachable from the LAN.
- **Nonce replay cache**: `/print`, `/test`, `/usb/print` require a
  fresh `X-Edge-Nonce` header. Nonces are single-use for 5 minutes.
- **Structured logging**: NDJSON to stdout + in-memory ring buffer
  used by `/support-bundle`.
- **/health**: distinct from `/status`; returns product, version,
  uptime, node/platform/arch, PID, RSS, recent-error count.
- **/support-bundle**: authenticated diagnostic snapshot (health +
  status + redacted config + last 500 log lines).

Nothing removed — `/status`, `/print`, `/test`, `/discover`,
`/usb/devices`, `/usb/print`, `/biometric/*` keep their contracts.

## Quick start

```bash
cd agent
npm install
npm run dev
```

Listens on `http://127.0.0.1:8043`.

## API surface

| Method | Path              | Auth | Description                                   |
|--------|-------------------|------|-----------------------------------------------|
| GET    | `/status`         | no   | Discovered devices (inventory for the ERP)    |
| GET    | `/health`         | no   | Runtime health (product, version, resources)  |
| GET    | `/support-bundle` | yes  | Diagnostic snapshot for support               |
| POST   | `/print`          | yes  | Network print (raw TCP) — needs `X-Edge-Nonce`|
| POST   | `/test`           | yes  | TCP connectivity test — needs `X-Edge-Nonce`  |
| GET    | `/discover`       | yes  | LAN discovery on port 9100                    |
| GET    | `/usb/devices`    | yes  | USB device enumeration                        |
| POST   | `/usb/print`      | yes  | USB print — needs `X-Edge-Nonce`              |
| any    | `/biometric/*`    | yes  | Biometric vendor bridge                       |

Mutating routes require a `X-Edge-Nonce: <uuid>` header. Any 128-bit
opaque string ≥8 chars works; a fresh `crypto.randomUUID()` per request
is recommended.

## Authentication

Bearer token generated on first run, stored in `~/.pos-agent-token`
(mode 0600). Set `AGENT_AUTH_DISABLED=1` for dev only.

## Configuration

| Env var                  | Default    | Description                              |
|--------------------------|------------|------------------------------------------|
| `AGENT_PORT`             | `8043`     | Loopback port                            |
| `AGENT_AUTH_DISABLED`    | (unset)    | `1` skips auth. Dev only.                |
| `AGENT_ALLOWED_ORIGINS`  | (unset)    | Comma-separated extra allowed origins    |

## Roadmap

- Phase 2 — Outbound WebSocket relay to `wss://edge-relay.accrualflow.systems`.
- Phase 3 — Capability manifest published by the agent.
- Phase 4 — Electron desktop shell (tray, diagnostics, updates).
- Phase 5 — Plugin drivers (`@accrualflow/edge-drivers-*`).
- Phase 6 — Observability + admin console.

See `.lovable/plan.md` for full detail.
