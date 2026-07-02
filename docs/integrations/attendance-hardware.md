# Attendance Hardware Integration

How to connect external attendance terminals (ZKTeco, Hikvision, Suprema,
generic RFID, biometric, kiosk gateways) to the ERP.

Attendance is a **provider-based** architecture: hardware is just another
data source. Every external device ingests attendance events through a
single signed HTTPS endpoint and never touches the database directly.

---

## 1. Endpoint

```
POST  https://<project>.lovable.app/api/public/attendance.ingest
Content-Type: application/json
X-Device-Id:        <attendance_devices.id>
X-Signature:        <hex hmac-sha256>
X-Timestamp:        <unix seconds, must be within ±300 s of server time>
X-Idempotency-Key:  <unique per-event id, ≤128 chars>
```

The route is implemented in `src/routes/api/public/attendance.ingest.ts`
(TanStack server route). It:

1. Loads the device by `X-Device-Id` (status must be `active`).
2. Recomputes `HMAC_SHA256(secret, X-Timestamp + "\n" + body)` and constant-time
   compares it to `X-Signature`. Rejects with `401` on mismatch.
3. Rejects if `|now - X-Timestamp| > 300`.
4. Looks up `X-Idempotency-Key` in `attendance_ingest_log`. If present, returns the
   prior result (replay-safe, terminals can retry without duplicating events).
5. Resolves the employee by `external_attendance_ref` (badge/biometric template
   id, RFID UID, etc.) — unique per organization.
6. Calls the canonical SECURITY DEFINER RPC (`attendance_clock_in` or
   `attendance_clock_out`). All enforcement (geofence, shift window, duplicate,
   impossible-travel) runs server-side; the terminal cannot bypass it.
7. Persists the result keyed by `X-Idempotency-Key`.

---

## 2. Request body schema

```json
{
  "action": "clock_in" | "clock_out",
  "external_employee_ref": "ZK-00154",
  "occurred_at": "2026-06-07T08:00:12.000Z",
  "lat": -1.292066,
  "lng": 36.821946,
  "accuracy_m": 8.5,
  "metadata": {
    "verify_method": "fingerprint" | "face" | "rfid" | "pin",
    "confidence": 0.94,
    "terminal_model": "ZKTeco K40",
    "firmware": "Ver 6.60"
  }
}
```

- `action` — required.
- `external_employee_ref` — required. Must match `employees.external_attendance_ref`
  for the device's organization. The DB has `UNIQUE(organization_id, external_attendance_ref)`.
- `occurred_at` — optional; defaults to `X-Timestamp` server-side. Use this only
  if the terminal buffers events offline.
- `lat`/`lng`/`accuracy_m` — optional but recommended; used by geofence and
  impossible-travel checks.
- `metadata.verify_method` — recorded into the `attendance_events` audit log;
  drives confidence reporting and `source` classification.

Response shapes:

| Status | Body                                              | Meaning                                          |
| ------ | ------------------------------------------------- | ------------------------------------------------ |
| 200    | `{ ok: true, attendance_id, event_id }`           | Recorded.                                        |
| 200    | `{ ok: true, idempotent: true, …prior result }`   | Replay of a previous successful event.           |
| 401    | `{ error: "invalid_signature" \| "stale_request" }` | HMAC or timestamp window failure.                |
| 404    | `{ error: "unknown_device" \| "unknown_employee" }` | Device id or `external_employee_ref` mismatch. |
| 409    | `{ error: "<CANONICAL_CODE>" }`                   | Policy denied. See §5.                           |

---

## 3. HMAC computation

Both server and device must compute identically:

```
mac = HMAC_SHA256(
  key   = device.hmac_secret,           -- bytea, 32 bytes, base64-encoded when delivered
  data  = utf8(X-Timestamp + "\n" + raw_request_body)
)
X-Signature = hex(mac)                  -- lowercase
```

### Python reference

```python
import hmac, hashlib, time, json, requests, base64
secret = base64.b64decode(DEVICE_SECRET)   # delivered once at registration
body   = json.dumps(payload, separators=(",", ":")).encode("utf-8")
ts     = str(int(time.time()))
sig    = hmac.new(secret, (ts + "\n").encode() + body, hashlib.sha256).hexdigest()

requests.post(
  ENDPOINT,
  data=body,
  headers={
    "Content-Type":      "application/json",
    "X-Device-Id":       DEVICE_ID,
    "X-Signature":       sig,
    "X-Timestamp":       ts,
    "X-Idempotency-Key": f"{DEVICE_ID}:{event_serial}",
  },
)
```

### Node reference

```ts
import { createHmac } from "node:crypto";
const ts   = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify(payload);
const sig  = createHmac("sha256", Buffer.from(DEVICE_SECRET, "base64"))
  .update(ts + "\n" + body)
  .digest("hex");
```

---

## 4. Device lifecycle (HR/admin RPCs)

Visible at `/hr/attendance/devices`. RPCs:

| RPC                                | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `attendance_device_register(...)`  | Creates a device, returns `{ id, hmac_secret_b64 }` ONCE. Show, never store. |
| `attendance_device_set_status(...)` | `active` ↔ `suspended` ↔ `revoked`. Suspended/revoked devices receive `401`. |
| `attendance_device_rotate_secret(...)` (planned) | Issues a new secret; old secret accepted for 60 s grace.   |

The device secret is stored as `bytea`. The plaintext is shown to the operator
exactly once at register time — copy it into the terminal's configuration
immediately.

---

## 5. Canonical denial codes

Returned in the `error` field with HTTP 409. The same codes drive UI messages
in `useAttendanceActions.mapRpcError` and the Audit page's chip filters.

| Code                      | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `ALREADY_CLOCKED_IN`      | Employee has an open session.                                        |
| `DUPLICATE_RECENT_ATTEMPT`| Inside `min_clock_interval_seconds`.                                 |
| `IMPOSSIBLE_TRAVEL`       | Speed between last and current location > `max_speed_kmh`.           |
| `ON_APPROVED_LEAVE`       | Day is stamped `on_leave` from leave approval.                       |
| `OUTSIDE_SHIFT_WINDOW`    | Outside the shift's `early/late_clock_in_minutes` window.            |
| `GEO_REQUIRED`            | `geofence_required=true` and no coords supplied.                     |
| `OUTSIDE_GEOFENCE`        | Coords supplied, outside the geofence radius.                        |
| `NO_GEOFENCE_DEFINED`     | `geofence_required=true` but no geofence configured.                 |
| `SELFIE_REQUIRED`         | `selfie_required=true` and `metadata.verify_method` is not biometric. |
| `UNTRUSTED_DEVICE`        | `device_binding_required=true` and device not yet HR-approved.       |
| `DEVICE_REVOKED`          | Device explicitly revoked.                                           |
| `KIOSK_PIN_INVALID`       | Kiosk PIN required and missing/wrong.                                |

Every attempt — allow OR deny — appends a row to `attendance_events`
(append-only). Vendors can correlate by `X-Idempotency-Key`.

---

## 6. Vendor adapter notes

### ZKTeco K40 / K50 / SF200

- Uses `PUSH` protocol; configure server URL + signature secret in
  `Comm > Cloud Server Setting`.
- `verify_method`: 1=fingerprint, 4=card, 15=face. Map to our `metadata.verify_method`.
- Map `EnrollNumber` (device PIN) to `external_attendance_ref` at HR onboarding.

### Hikvision DS-K1T6

- Use **ISAPI / Acs / AcsEvent listener** with HTTP push.
- Send the device's `serialNo` as `X-Device-Id` after registering it in HR.
- `attendanceStatus` field → `clock_in` (Check-In) / `clock_out` (Check-Out);
  others (Break-In/Out) should map to break RPCs (not yet wired through ingest;
  use the in-app break controls instead, or build a follow-up adapter).

### Suprema BioStar 2

- Use **CoreStation event push** with a thin adapter service that reformats
  events to the schema in §2 and signs them with the device secret.
- Suprema's biometric template id → `external_attendance_ref`.

### Generic RFID reader

- Compose JSON with `metadata.verify_method = "rfid"` and the card UID as
  `external_employee_ref` (map UID → employee at HR onboarding).

---

## 7. Operational notes

- All clock policy lives in `attendance_settings` (per business). Vendors
  cannot override it.
- The device's clock does not need to be in sync with employees' phones — only
  with the server (±300 s).
- Idempotency keys may be replayed indefinitely; the log keeps prior responses
  so a flaky uplink never produces double attendance.
- `attendance_events` is append-only at the database level
  (`REVOKE UPDATE, DELETE`). It is the canonical forensic record.

Cross-reference: `mem://features/attendance.md`,
`docs/audit/2026-05-05-attendance-overhaul-verdict.md`.
