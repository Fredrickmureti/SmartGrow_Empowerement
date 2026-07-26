// AccrualFlow Edge — workstation manifest publish endpoint (Phase 3).
//
// The agent POSTs its full capability manifest here on connect and whenever
// its device inventory changes. Auth is the workstation bearer secret,
// matching edge-agent-poll / edge-agent-complete.
//
// Body:
//   {
//     "agent_version": "1.3.0-edge.p3",
//     "devices": [
//       {
//         "device_key": "usb:04b8:0e15",
//         "role": "receipt_printer",
//         "transport": "usb",
//         "driver": "escpos",
//         "name": "Epson TM-T20III",
//         "capabilities": { "width_mm": 80, "cutter": true, "cash_drawer_kick": true },
//         "health": "ok",
//         "metadata": { "vendor_id": 1208, "product_id": 3605 }
//       },
//       ...
//     ]
//   }
//
// Effect:
//   1. Upserts one row per device into public.workstation_devices (keyed
//      by (workstation_id, device_key)) and marks any previously-known
//      device that isn't in this payload as `health='offline'`.
//   2. Inserts a full snapshot into public.workstation_manifests so we
//      keep an auditable history.
//
// Response: { ok: true, devices: <count>, manifest_id: <uuid> }

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function authorizeWorkstation(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  const wsId = req.headers.get('X-Workstation-Id') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secret) return { ok: false as const, status: 401, error: 'missing_bearer' };
  if (!wsId) return { ok: false as const, status: 400, error: 'missing_workstation_id' };
  const hash = await sha256Hex(secret);
  const { data, error } = await admin
    .from('workstations')
    .select('id, organization_id, secret_hash, secret_rotated_at')
    .eq('id', wsId)
    .maybeSingle();
  if (error) return { ok: false as const, status: 500, error: 'db_error' };
  if (!data) return { ok: false as const, status: 404, error: 'workstation_not_found' };
  if (data.secret_hash !== hash) return { ok: false as const, status: 401, error: 'invalid_secret' };
  return {
    ok: true as const,
    workstationId: data.id,
    organizationId: data.organization_id,
    secretRotatedAt: data.secret_rotated_at as string | null,
  };
}

/**
 * Phase 4.2.7b — loopback TLS identity reported by the agent.
 *
 * The fingerprint is what the browser pins before it will talk to
 * `https://127.0.0.1:<tls_port>`, so it is only ever accepted from a
 * request that already proved possession of the workstation secret
 * (above). We validate the shape strictly: a 64-char lowercase hex
 * SHA-256 and a port in the unprivileged range. Anything else is
 * dropped rather than stored, so a malformed agent build can't poison
 * the value the ERP pins against.
 */
interface IncomingTls {
  tls_fingerprint_sha256: string | null;
  tls_port: number | null;
  tls_generated_at: string | null;
}

function validateTls(raw: unknown): IncomingTls | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (t.enabled === false) {
    return { tls_fingerprint_sha256: null, tls_port: null, tls_generated_at: null };
  }
  const fp = typeof t.fingerprint_sha256 === 'string' ? t.fingerprint_sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(fp)) return null;
  const port = typeof t.port === 'number' && Number.isInteger(t.port) && t.port > 1024 && t.port < 65536
    ? t.port
    : null;
  const generatedAt = typeof t.generated_at === 'string' && !Number.isNaN(Date.parse(t.generated_at))
    ? new Date(t.generated_at).toISOString()
    : null;
  return { tls_fingerprint_sha256: fp, tls_port: port, tls_generated_at: generatedAt };
}


const ALLOWED_ROLES = new Set([
  'receipt_printer', 'label_printer', 'scanner', 'drawer', 'scale', 'display',
  'eft_terminal', 'biometric', 'signature_pad', 'rfid_reader', 'camera', 'other',
]);
const ALLOWED_TRANSPORTS = new Set(['usb', 'tcp', 'serial', 'bluetooth', 'hid', 'virtual', 'other']);
const ALLOWED_HEALTH = new Set(['ok', 'degraded', 'offline', 'error', 'unknown']);

interface IncomingDevice {
  device_key: string;
  role: string;
  transport: string;
  driver?: string | null;
  name?: string | null;
  capabilities?: Record<string, unknown>;
  health?: string;
  metadata?: Record<string, unknown>;
}

function validate(payload: unknown): { ok: true; devices: IncomingDevice[]; agentVersion?: string } | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_body' };
  const body = payload as Record<string, unknown>;
  const list = body.devices;
  if (!Array.isArray(list)) return { ok: false, error: 'devices_not_array' };
  if (list.length > 128) return { ok: false, error: 'too_many_devices' };
  const out: IncomingDevice[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'device_not_object' };
    const d = raw as Record<string, unknown>;
    const device_key = typeof d.device_key === 'string' ? d.device_key.slice(0, 200) : '';
    const role = typeof d.role === 'string' ? d.role : '';
    const transport = typeof d.transport === 'string' ? d.transport : '';
    if (!device_key) return { ok: false, error: 'missing_device_key' };
    if (!ALLOWED_ROLES.has(role)) return { ok: false, error: `invalid_role:${role}` };
    if (!ALLOWED_TRANSPORTS.has(transport)) return { ok: false, error: `invalid_transport:${transport}` };
    const health = typeof d.health === 'string' && ALLOWED_HEALTH.has(d.health) ? d.health : 'unknown';
    out.push({
      device_key,
      role,
      transport,
      driver: typeof d.driver === 'string' ? d.driver.slice(0, 80) : null,
      name: typeof d.name === 'string' ? d.name.slice(0, 200) : null,
      capabilities: (d.capabilities && typeof d.capabilities === 'object') ? d.capabilities as Record<string, unknown> : {},
      health,
      metadata: (d.metadata && typeof d.metadata === 'object') ? d.metadata as Record<string, unknown> : {},
    });
  }
  const agentVersion = typeof body.agent_version === 'string' ? body.agent_version.slice(0, 40) : undefined;
  return { ok: true, devices: out, agentVersion };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const auth = await authorizeWorkstation(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const body = await req.json().catch(() => null);
  const v = validate(body);
  if (!v.ok) return json(400, { error: v.error });

  const nowIso = new Date().toISOString();
  const seenKeys = v.devices.map((d) => d.device_key);

  // Upsert each device
  if (v.devices.length > 0) {
    const rows = v.devices.map((d) => ({
      organization_id: auth.organizationId,
      workstation_id: auth.workstationId,
      device_key: d.device_key,
      role: d.role,
      transport: d.transport,
      driver: d.driver,
      name: d.name,
      capabilities: d.capabilities,
      health: d.health,
      metadata: d.metadata,
      last_seen_at: nowIso,
    }));
    const { error: upErr } = await admin
      .from('workstation_devices')
      .upsert(rows, { onConflict: 'workstation_id,device_key' });
    if (upErr) return json(500, { error: upErr.message });
  }

  // Mark any previously-known device NOT in this payload as offline.
  if (seenKeys.length > 0) {
    await admin
      .from('workstation_devices')
      .update({ health: 'offline', updated_at: nowIso })
      .eq('workstation_id', auth.workstationId)
      .not('device_key', 'in', `(${seenKeys.map((k) => `"${k.replace(/"/g, '""')}"`).join(',')})`);
  } else {
    await admin
      .from('workstation_devices')
      .update({ health: 'offline', updated_at: nowIso })
      .eq('workstation_id', auth.workstationId);
  }

  const { data: manifest, error: mErr } = await admin
    .from('workstation_manifests')
    .insert({
      organization_id: auth.organizationId,
      workstation_id: auth.workstationId,
      agent_version: v.agentVersion,
      payload: { devices: v.devices, published_at: nowIso },
    })
    .select('id')
    .maybeSingle();
  if (mErr) return json(500, { error: mErr.message });

  // Heartbeat
  await admin
    .from('workstations')
    .update({ last_seen_at: nowIso, version: v.agentVersion })
    .eq('id', auth.workstationId);

  return json(200, { ok: true, devices: v.devices.length, manifest_id: manifest?.id });
});
