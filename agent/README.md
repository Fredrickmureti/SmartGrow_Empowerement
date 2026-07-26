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

## Phase 2 — Supabase relay transport

The loopback listener alone cannot be reached from
`https://www.accrualflow.systems` (mixed-content). Phase 2 adds a
durable, browser-safe path via Supabase:

```
Browser (https://…)
  └─ INSERT public.edge_jobs { workstation_id, role, payload, idempotency_key }
       ↑ RLS: only org members can enqueue for their own workstations
       ↓ Realtime UPDATE observed by the browser when the agent completes

Agent (this runtime, on the customer workstation)
  └─ POST /functions/v1/edge/agent/poll     (Bearer <workstation_secret>)
     POST /functions/v1/edge/agent/complete (Bearer <workstation_secret>)
       ↑ hash-verified against workstations.secret_hash server-side
```

### Enrolment (one-time, per workstation)

1. From the ERP admin console, an org member calls the
   `edge/workstation/register` edge function with a friendly
   `name`. The response contains a UUID `id` and a raw
   `secret` shown **once**.
2. Drop the following into
   `~/.accrualflow/edge/workstation.json` on the workstation
   (or point `ACCRUALFLOW_EDGE_CONFIG` at any other path):

   ```json
   {
     "supabase_url": "https://<ref>.supabase.co",
     "workstation_id": "<uuid returned from register>",
     "workstation_secret": "<raw secret returned once>"
   }
   ```

3. Restart the runtime. On start, if the config file is present the
   agent begins polling `edge/agent/poll` every ~1.5 s and posting
   results back to `edge/agent/complete`. If the file is missing,
   the runtime logs `relay.inactive.no_config` and only serves the
   loopback listener (existing dev flow — unchanged).

### Configuration

| Env var                    | Default                                | Description                          |
|----------------------------|----------------------------------------|--------------------------------------|
| `AGENT_PORT`               | `8043`                                 | Loopback port                        |
| `AGENT_AUTH_DISABLED`      | (unset)                                | `1` skips loopback auth. Dev only.   |
| `AGENT_ALLOWED_ORIGINS`    | (unset)                                | Extra CORS origins (comma-separated) |
| `ACCRUALFLOW_EDGE_CONFIG`  | `~/.accrualflow/edge/workstation.json` | Path to the workstation config       |

## Roadmap

- Phase 2 — Supabase relay transport (edge_jobs table + edge functions). **Shipped in this build.**
- Phase 3 — Capability manifest published by the agent.
- Phase 4 — Electron desktop shell (tray, diagnostics, enrolment wizard, updates).
- Phase 5 — Plugin drivers (`@accrualflow/edge-drivers-*`).
- Phase 6 — Observability + admin console.

See `.lovable/plan.md` for full detail.
