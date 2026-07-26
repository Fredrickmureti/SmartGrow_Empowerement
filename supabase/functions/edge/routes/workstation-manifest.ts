// AccrualFlow Edge — workstation manifest publish route.
// Moved verbatim from edge-workstation-manifest/index.ts.

import { admin, authorizeWorkstation, json } from '../_shared.ts';

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

export async function handle(req: Request): Promise<Response> {
  const auth = await authorizeWorkstation(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const body = await req.json().catch(() => null);
  const v = validate(body);
  if (!v.ok) return json(400, { error: v.error });

  const nowIso = new Date().toISOString();
  const seenKeys = v.devices.map((d) => d.device_key);

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

  const tls = validateTls((body as Record<string, unknown> | null)?.tls);
  await admin
    .from('workstations')
    .update({
      last_seen_at: nowIso,
      version: v.agentVersion,
      ...(tls ?? {}),
    })
    .eq('id', auth.workstationId);

  return json(200, {
    ok: true,
    devices: v.devices.length,
    manifest_id: manifest?.id,
    secret_rotated_at: auth.secretRotatedAt ?? null,
  });
}
