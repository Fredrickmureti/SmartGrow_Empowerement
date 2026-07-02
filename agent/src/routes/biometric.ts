/**
 * Biometric LAN-agent route — bridges on-prem biometric devices
 * (ZKTeco / Suprema / Hikvision / generic) to the platform's
 * existing attendance ingest endpoint at /api/public/attendance/ingest.
 *
 * Wire contract (canonical, vendor-neutral):
 *
 *   POST /biometric/heartbeat           → 200 ack (no forward)
 *   POST /biometric/event               → forward as signed ingest
 *   POST /biometric/enroll-response     → 200 ack (server enroll API TBD)
 *
 * Each device's HMAC shared-secret is read from the env var
 *   BIOMETRIC_DEVICE_SECRET_<PUBLIC_ID>
 * where <PUBLIC_ID> is the upper-cased `attendance_devices.public_id`
 * with non-[A-Z0-9_] chars replaced by `_`.
 *
 * The ingest URL is read from BIOMETRIC_INGEST_URL (full URL including
 * /api/public/attendance/ingest). The agent never holds a Supabase
 * service-role key; the platform endpoint owns RLS bypass.
 *
 * Vendor SDK adapters (ZKTeco/Suprema/Hikvision) translate device
 * payloads into the canonical body below and POST here. They are
 * shipped in a separate package and out of scope for this loop.
 */

import crypto from 'node:crypto';
import type http from 'node:http';

type BiometricEventKind = 'check_in' | 'check_out' | 'break_start' | 'break_end' | 'unknown';

interface BiometricEventBody {
  deviceId: string;
  externalEmployeeId: string;
  kind: BiometricEventKind;
  occurredAt: string;
  matchScore?: number;
  lat?: number;
  lng?: number;
  photoUrl?: string;
}

interface BiometricHeartbeatBody {
  deviceId: string;
  vendor?: string;
  firmware?: string;
  deviceTime?: string;
  enrolledTemplates?: number;
}

interface AgentResult {
  status: number;
  body: unknown;
}

function envSecretKey(deviceId: string): string {
  return `BIOMETRIC_DEVICE_SECRET_${deviceId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

function loadSecret(deviceId: string): Buffer | null {
  const raw = process.env[envSecretKey(deviceId)];
  if (!raw) return null;
  // Accept hex (64 chars) or raw utf8 string.
  if (/^[0-9a-f]{32,}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'utf8');
}

function mapKind(kind: BiometricEventKind): 'in' | 'out' | 'break_start' | 'break_end' | null {
  switch (kind) {
    case 'check_in': return 'in';
    case 'check_out': return 'out';
    case 'break_start': return 'break_start';
    case 'break_end': return 'break_end';
    default: return null;
  }
}

function validateEvent(body: unknown): { ok: true; value: BiometricEventBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || !b.deviceId) return { ok: false, error: 'deviceId required' };
  if (typeof b.externalEmployeeId !== 'string' || !b.externalEmployeeId) return { ok: false, error: 'externalEmployeeId required' };
  if (typeof b.kind !== 'string') return { ok: false, error: 'kind required' };
  if (typeof b.occurredAt !== 'string') return { ok: false, error: 'occurredAt required' };
  return { ok: true, value: b as unknown as BiometricEventBody };
}

function validateHeartbeat(body: unknown): { ok: true; value: BiometricHeartbeatBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || !b.deviceId) return { ok: false, error: 'deviceId required' };
  return { ok: true, value: b as unknown as BiometricHeartbeatBody };
}

/**
 * Forward a canonical event to the platform's attendance ingest endpoint
 * using the device's HMAC shared-secret.
 */
export async function forwardEvent(event: BiometricEventBody): Promise<AgentResult> {
  const ingestUrl = process.env.BIOMETRIC_INGEST_URL;
  if (!ingestUrl) return { status: 503, body: { error: 'BIOMETRIC_INGEST_URL not configured' } };

  const secret = loadSecret(event.deviceId);
  if (!secret) return { status: 401, body: { error: 'device_secret_missing', envKey: envSecretKey(event.deviceId) } };

  const mappedKind = mapKind(event.kind);
  if (!mappedKind) return { status: 400, body: { error: 'unsupported_kind', kind: event.kind } };

  const payload = {
    employee_ref: event.externalEmployeeId,
    kind: mappedKind,
    ts: event.occurredAt,
    ...(event.lat != null ? { lat: event.lat } : {}),
    ...(event.lng != null ? { lng: event.lng } : {}),
    ...(event.matchScore != null ? { confidence: event.matchScore / 100 } : {}),
    ...(event.photoUrl ? { photo_url: event.photoUrl } : {}),
  };
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

  try {
    const res = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': event.deviceId,
        'x-signature': sig,
        'x-timestamp': ts,
      },
      body,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 502, body: { error: 'ingest_unreachable', detail: (err as Error).message } };
  }
}

/** Heartbeat handler — ack-only; vendor SDKs use it to assert agent liveness. */
export async function handleBiometricHeartbeat(rawBody: string): Promise<AgentResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  const v = validateHeartbeat(parsed);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  return { status: 200, body: { ack: true, deviceId: v.value.deviceId, agentTime: new Date().toISOString() } };
}

export async function handleBiometricEvent(rawBody: string): Promise<AgentResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  const v = validateEvent(parsed);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  return forwardEvent(v.value);
}

export async function handleBiometricEnrollResponse(rawBody: string): Promise<AgentResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  // Enroll responses are recorded by the device after a server-initiated
  // enroll. The server-side enroll API does not yet exist; ack so the
  // device clears its pending-enroll queue. Future: insert into
  // employee_credentials (already in schema) when enroll API lands.
  return { status: 200, body: { ack: true, received: parsed } };
}

/** Dispatch helper for the http server to keep server.ts thin. */
export async function dispatchBiometric(
  method: string,
  path: string,
  readBody: () => Promise<string>,
): Promise<AgentResult | null> {
  if (method !== 'POST') return null;
  if (path === '/biometric/heartbeat') return handleBiometricHeartbeat(await readBody());
  if (path === '/biometric/event') return handleBiometricEvent(await readBody());
  if (path === '/biometric/enroll-response') return handleBiometricEnrollResponse(await readBody());
  return null;
}

// Internal exports for tests
export const __test = { envSecretKey, mapKind };
export type { BiometricEventBody, BiometricHeartbeatBody, AgentResult };
