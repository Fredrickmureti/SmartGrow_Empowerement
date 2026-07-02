/**
 * biometric-ingest — canonical, vendor-neutral endpoint for biometric
 * attendance devices (ZKTeco / Suprema / Hikvision / generic). Called
 * by the LAN agent (or directly by a vendor's cloud) with HMAC-signed
 * heartbeat / event / enroll-response payloads.
 *
 * Auth: NOT JWT-based. Every request must carry:
 *   x-device-id   the device's `attendance_devices.public_id`
 *   x-timestamp   ISO8601, ±5 minutes from now (anti-replay)
 *   x-signature   hex HMAC-SHA256 over `${timestamp}.${rawBody}`
 *                 using the device's `hmac_secret` (bytea in the table)
 *
 * The function holds the service-role key; the agent and the device
 * never do. Replay/dedup is enforced via attendance_ingest_log.payload_hash.
 *
 * Body is one of:
 *   { kind: 'heartbeat', deviceId, vendor?, firmware?, deviceTime?, enrolledTemplates? }
 *   { kind: 'event',     deviceId, externalEmployeeId, eventKind, occurredAt, matchScore?, lat?, lng? }
 *   { kind: 'enroll',    deviceId, externalEmployeeId, status }
 *
 * eventKind ∈ { check_in, check_out, break_start, break_end }
 */
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const HeartbeatSchema = z.object({
  kind: z.literal('heartbeat'),
  deviceId: z.string().min(1),
  vendor: z.string().optional(),
  firmware: z.string().optional(),
  deviceTime: z.string().datetime().optional(),
  enrolledTemplates: z.number().int().nonnegative().optional(),
});

const EventSchema = z.object({
  kind: z.literal('event'),
  deviceId: z.string().min(1),
  externalEmployeeId: z.string().min(1),
  eventKind: z.enum(['check_in', 'check_out', 'break_start', 'break_end']),
  occurredAt: z.string().datetime(),
  matchScore: z.number().min(0).max(1).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

const EnrollSchema = z.object({
  kind: z.literal('enroll'),
  deviceId: z.string().min(1),
  externalEmployeeId: z.string().min(1),
  status: z.enum(['ok', 'failed', 'duplicate']),
  reason: z.string().optional(),
});

const BodySchema = z.discriminatedUnion('kind', [HeartbeatSchema, EventSchema, EnrollSchema]);

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function hmacHex(secret: ArrayBuffer, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeHmacSecret(raw: unknown): ArrayBuffer | null {
  if (typeof raw !== 'string') return null;
  // PostgREST returns bytea as either base64 or a "\x..." hex string.
  if (raw.startsWith('\\x')) {
    const hex = raw.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out.buffer;
  }
  // Treat as base64
  try {
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } catch {
    return null;
  }
}

function mapKind(eventKind: string): string {
  switch (eventKind) {
    case 'check_in':   return 'clock_in';
    case 'check_out':  return 'clock_out';
    case 'break_start':return 'break_start';
    case 'break_end':  return 'break_end';
    default:           return 'unknown';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResp(405, { error: 'method_not_allowed' });

  const devicePublicId = req.headers.get('x-device-id');
  const ts = req.headers.get('x-timestamp');
  const sig = req.headers.get('x-signature');
  if (!devicePublicId || !ts || !sig) {
    return jsonResp(401, { error: 'missing_auth_headers' });
  }

  // Anti-replay: ±5 minute window
  const tsDate = new Date(ts);
  if (Number.isNaN(tsDate.getTime()) || Math.abs(Date.now() - tsDate.getTime()) > 5 * 60 * 1000) {
    return jsonResp(401, { error: 'timestamp_out_of_window' });
  }

  const rawBody = await req.text();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up device + HMAC secret
  const { data: device, error: devErr } = await supabase
    .from('attendance_devices')
    .select('id, organization_id, business_id, branch_id, hmac_secret, status')
    .eq('public_id', devicePublicId)
    .maybeSingle();

  if (devErr || !device) return jsonResp(401, { error: 'unknown_device' });
  if (device.status === 'revoked' || device.status === 'disabled') {
    return jsonResp(403, { error: 'device_disabled' });
  }

  const secret = decodeHmacSecret(device.hmac_secret);
  if (!secret) return jsonResp(500, { error: 'device_secret_unreadable' });

  const expected = await hmacHex(secret, `${ts}.${rawBody}`);
  if (!timingSafeEqHex(expected, sig)) {
    return jsonResp(401, { error: 'bad_signature' });
  }

  // Parse + validate body
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(rawBody); } catch { return jsonResp(400, { error: 'invalid_json' }); }
  const parsed = BodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return jsonResp(400, { error: 'invalid_body', detail: parsed.error.flatten() });
  }
  const body = parsed.data;

  // Idempotency / replay dedupe via payload hash
  const payloadHash = await sha256Hex(rawBody);
  const { data: existing } = await supabase
    .from('attendance_ingest_log')
    .select('id, attendance_id, accepted')
    .eq('payload_hash', payloadHash)
    .maybeSingle();
  if (existing) {
    return jsonResp(200, { success: true, duplicate: true, eventId: existing.attendance_id });
  }

  // Heartbeat — record + update device last_seen, no attendance row
  if (body.kind === 'heartbeat') {
    await supabase.from('attendance_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id);
    await supabase.from('attendance_ingest_log').insert({
      device_id: device.id,
      device_public_id: devicePublicId,
      payload_hash: payloadHash,
      kind: 'heartbeat',
      ts: ts,
      accepted: true,
    });
    return jsonResp(200, { success: true, kind: 'heartbeat' });
  }

  // Enroll response — record only (server-side enroll workflow lives elsewhere)
  if (body.kind === 'enroll') {
    await supabase.from('attendance_ingest_log').insert({
      device_id: device.id,
      device_public_id: devicePublicId,
      payload_hash: payloadHash,
      employee_ref: body.externalEmployeeId,
      kind: `enroll:${body.status}`,
      ts: ts,
      accepted: body.status === 'ok',
      reason: body.reason ?? null,
    });
    return jsonResp(200, { success: true, kind: 'enroll' });
  }

  // Wave B3.3 — bound device-reported occurredAt to prevent clock-skew or
  // malicious backdating from corrupting payroll. Accept events from the
  // last 30 days through 5 minutes in the future; reject the rest.
  const occurredAtDate = new Date(body.occurredAt);
  const occurredAtMs = occurredAtDate.getTime();
  const nowMs = Date.now();
  if (
    Number.isNaN(occurredAtMs) ||
    occurredAtMs < nowMs - 30 * 24 * 60 * 60 * 1000 ||
    occurredAtMs > nowMs + 5 * 60 * 1000
  ) {
    await supabase.from('attendance_ingest_log').insert({
      device_id: device.id,
      device_public_id: devicePublicId,
      payload_hash: payloadHash,
      employee_ref: body.externalEmployeeId,
      kind: mapKind(body.eventKind),
      ts: body.occurredAt,
      accepted: false,
      reason: 'occurred_at_out_of_window',
    });
    return jsonResp(422, { error: 'occurred_at_out_of_window' });
  }

  // Wave B3.2 — resolve via employee_device_identifiers first (multi-
  // identifier model), fall back to employees.external_attendance_ref
  // for one release for backward compatibility.
  let employee: { id: string; organization_id: string; business_id: string | null; branch_id: string | null } | null = null;

  const { data: ident, error: identErr } = await supabase
    .from('employee_device_identifiers')
    .select('employee_id, employees!inner(id, organization_id, business_id, branch_id)')
    .eq('organization_id', device.organization_id)
    .eq('identifier', body.externalEmployeeId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (identErr && identErr.code !== 'PGRST116') {
    return jsonResp(500, { error: 'identifier_lookup_failed' });
  }
  if (ident && (ident as unknown as { employees: typeof employee }).employees) {
    employee = (ident as unknown as { employees: NonNullable<typeof employee> }).employees;
  }

  if (!employee) {
    const { data: legacyEmployee, error: empErr } = await supabase
      .from('employees')
      .select('id, organization_id, business_id, branch_id')
      .eq('organization_id', device.organization_id)
      .eq('external_attendance_ref', body.externalEmployeeId)
      .maybeSingle();
    if (empErr) return jsonResp(500, { error: 'employee_lookup_failed' });
    employee = legacyEmployee;
  }

  if (!employee) {
    await supabase.from('attendance_ingest_log').insert({
      device_id: device.id,
      device_public_id: devicePublicId,
      payload_hash: payloadHash,
      employee_ref: body.externalEmployeeId,
      kind: mapKind(body.eventKind),
      ts: body.occurredAt,
      accepted: false,
      reason: 'unknown_employee',
    });
    return jsonResp(404, { error: 'unknown_employee' });
  }

  const eventType = mapKind(body.eventKind);
  const { data: evt, error: evtErr } = await supabase
    .from('attendance_events')
    .insert({
      organization_id: employee.organization_id,
      business_id: employee.business_id ?? device.business_id,
      branch_id: employee.branch_id ?? device.branch_id,
      employee_id: employee.id,
      event_type: eventType,
      source: 'biometric',
      decision: 'accepted',
      // Wave B3.3 — preserve device-reported time. Readers MUST coalesce
      // event_time with created_at; historical rows have event_time NULL.
      event_time: occurredAtDate.toISOString(),
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      device_fingerprint: devicePublicId,
      metadata: {
        device_id: device.id,
        match_score: body.matchScore ?? null,
        occurred_at: body.occurredAt,
        vendor_event_kind: body.eventKind,
      },
    })
    .select('id')
    .single();


  if (evtErr) {
    await supabase.from('attendance_ingest_log').insert({
      device_id: device.id,
      device_public_id: devicePublicId,
      payload_hash: payloadHash,
      employee_ref: body.externalEmployeeId,
      kind: eventType,
      ts: body.occurredAt,
      accepted: false,
      reason: evtErr.message.slice(0, 240),
    });
    return jsonResp(500, { error: 'event_insert_failed', detail: evtErr.message });
  }

  await supabase.from('attendance_ingest_log').insert({
    device_id: device.id,
    device_public_id: devicePublicId,
    payload_hash: payloadHash,
    employee_ref: body.externalEmployeeId,
    kind: eventType,
    ts: body.occurredAt,
    accepted: true,
  });

  return jsonResp(200, { success: true, eventId: evt.id, eventType });
});
