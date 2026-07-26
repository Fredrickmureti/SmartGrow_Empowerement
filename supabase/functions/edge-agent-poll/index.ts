// AccrualFlow Edge — agent poll endpoint.
//
// The desktop agent presents `Authorization: Bearer <workstation_secret>`
// plus the workstation UUID in `X-Workstation-Id`. If the secret's SHA-256
// matches the stored `secret_hash`, we atomically claim one queued job for
// the workstation (FOR UPDATE SKIP LOCKED semantics via RPC) and return it,
// along with a lightweight heartbeat update (`last_seen_at`, `version`).
//
// The agent then executes the job locally and posts the outcome to
// `edge-agent-complete`.
//
// This path deliberately does NOT use the anon key or a user session — the
// agent runs on a customer workstation, has no browser context, and must not
// carry a user JWT. The workstation secret + service role writes are the
// trust boundary.

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

async function authorizeWorkstation(req: Request): Promise<
  { ok: true; workstationId: string; organizationId: string }
  | { ok: false; status: number; error: string }
> {
  const auth = req.headers.get('Authorization') ?? '';
  const wsId = req.headers.get('X-Workstation-Id') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secret) return { ok: false, status: 401, error: 'missing_bearer' };
  if (!wsId) return { ok: false, status: 400, error: 'missing_workstation_id' };
  const hash = await sha256Hex(secret);
  const { data, error } = await admin
    .from('workstations')
    .select('id, organization_id, secret_hash')
    .eq('id', wsId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: 'db_error' };
  if (!data) return { ok: false, status: 404, error: 'workstation_not_found' };
  if (data.secret_hash !== hash) return { ok: false, status: 401, error: 'invalid_secret' };
  return { ok: true, workstationId: data.id, organizationId: data.organization_id };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const auth = await authorizeWorkstation(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let version: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.version === 'string') version = body.version.slice(0, 40);
  } catch { /* ignore */ }

  // Heartbeat — best-effort, do not block on failure.
  await admin
    .from('workstations')
    .update({ last_seen_at: new Date().toISOString(), version: version ?? undefined })
    .eq('id', auth.workstationId);

  // Best-effort: expire jobs whose deadline has passed.
  await admin.rpc('edge_jobs_expire_stale').catch(() => undefined);

  // Claim one queued job for this workstation. We approximate SKIP LOCKED by
  // selecting the oldest queued row then conditionally updating it; a
  // concurrent claim will simply see 0 rows updated and we try again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: candidate } = await admin
      .from('edge_jobs')
      .select('id')
      .eq('workstation_id', auth.workstationId)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return json(200, { job: null });

    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from('edge_jobs')
      .update({ status: 'in_progress', claimed_at: nowIso, updated_at: nowIso })
      .eq('id', candidate.id)
      .eq('status', 'queued') // optimistic guard
      .select('id, role, op, payload, idempotency_key, deadline_at, created_at')
      .maybeSingle();
    if (claimErr) return json(500, { error: claimErr.message });
    if (claimed) return json(200, { job: claimed });
    // else lost the race — try the next candidate
  }
  return json(200, { job: null });
});
