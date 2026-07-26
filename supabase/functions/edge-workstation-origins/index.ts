// AccrualFlow Edge — tenant-scoped CORS allowlist (Phase 4.2.5).
//
// The loopback hardware agent lives on 127.0.0.1 but is called from the
// tenant's ERP browser origin. Baking origins into the agent binary means
// every custom domain requires a new release. This function instead lets
// the tenant own the allowlist:
//
//   GET /functions/v1/edge-workstation-origins
//   Authorization: Bearer <workstation_secret>
//   X-Workstation-Id: <workstation uuid>
//
// Returns:
//   {
//     "origins": ["https://erp.tenant.example", ...],
//     "ttl_seconds": 900,
//     "version": "<sha256(origins)>",
//     "fetched_at": "<ISO8601>"
//   }
//
// The agent fetches at start and every 15 min, caches to
// ~/.accrualflow/edge/origins.json, and merges the returned list with
// built-in defaults (localhost + accrualflow.systems) at request time.
//
// Auth model matches edge-workstation-manifest: workstation bearer secret
// hashed with SHA-256 and compared to workstations.secret_hash. No JWT
// verification — the workstation is not a Supabase user.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

const TTL_SECONDS = 900;

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

function isValidOrigin(o: unknown): o is string {
  if (typeof o !== 'string') return false;
  if (o.length === 0 || o.length > 253) return false;
  try {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // An Origin has no path, query, or fragment.
    if (u.pathname !== '/' && u.pathname !== '') return false;
    if (u.search || u.hash) return false;
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });

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

  // Best-effort last-seen touch so the operator sees a fresh timestamp.
  admin.from('workstations').update({ last_seen_at: new Date().toISOString() }).eq('id', ws.id).then(() => {});

  return json(200, {
    origins,
    ttl_seconds: TTL_SECONDS,
    version,
    fetched_at: new Date().toISOString(),
  });
});
