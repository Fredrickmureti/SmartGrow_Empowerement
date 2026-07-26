// AccrualFlow Edge — tenant-scoped CORS allowlist route.
// Moved verbatim from edge-workstation-origins/index.ts.

import { admin, json, sha256Hex } from '../_shared.ts';

const TTL_SECONDS = 900;

function isValidOrigin(o: unknown): o is string {
  if (typeof o !== 'string') return false;
  if (o.length === 0 || o.length > 253) return false;
  try {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.pathname !== '/' && u.pathname !== '') return false;
    if (u.search || u.hash) return false;
    return true;
  } catch {
    return false;
  }
}

export async function handle(req: Request): Promise<Response> {
  const auth = req.headers.get('Authorization') ?? '';
  const wsId = req.headers.get('X-Workstation-Id') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secret) return json(401, { error: 'missing_bearer' });
  if (!wsId) return json(400, { error: 'missing_workstation_id' });

  const hash = await sha256Hex(secret);
  const { data: ws, error: wsErr } = await admin
    .from('workstations')
    .select('id, organization_id, secret_hash')
    .eq('id', wsId)
    .maybeSingle();
  if (wsErr) return json(500, { error: 'db_error' });
  if (!ws) return json(404, { error: 'workstation_not_found' });
  if (ws.secret_hash !== hash) return json(401, { error: 'invalid_secret' });

  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .select('edge_allowed_origins')
    .eq('id', ws.organization_id)
    .maybeSingle();
  if (orgErr) return json(500, { error: 'db_error' });

  const raw = Array.isArray(org?.edge_allowed_origins) ? org!.edge_allowed_origins as unknown[] : [];
  const origins = Array.from(new Set(raw.filter(isValidOrigin))).slice(0, 64);
  const version = await sha256Hex(origins.join('\n'));

  admin.from('workstations').update({ last_seen_at: new Date().toISOString() }).eq('id', ws.id).then(() => {});

  return json(200, {
    origins,
    ttl_seconds: TTL_SECONDS,
    version,
    fetched_at: new Date().toISOString(),
  });
}
