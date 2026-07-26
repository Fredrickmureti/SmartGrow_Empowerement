// AccrualFlow Edge — agent completion endpoint.
//
// The desktop agent posts the outcome of a claimed job here. Authentication
// mirrors `edge-agent-poll`: bearer workstation secret + workstation UUID.

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

interface CompleteBody {
  job_id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const auth = req.headers.get('Authorization') ?? '';
  const wsId = req.headers.get('X-Workstation-Id') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secret) return json(401, { error: 'missing_bearer' });
  if (!wsId) return json(400, { error: 'missing_workstation_id' });

  const hash = await sha256Hex(secret);
  const { data: ws } = await admin
    .from('workstations')
    .select('id, secret_hash')
    .eq('id', wsId)
    .maybeSingle();
  if (!ws) return json(404, { error: 'workstation_not_found' });
  if (ws.secret_hash !== hash) return json(401, { error: 'invalid_secret' });

  let body: CompleteBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!body.job_id || typeof body.job_id !== 'string') {
    return json(400, { error: 'job_id required' });
  }
  if (typeof body.success !== 'boolean') {
    return json(400, { error: 'success must be a boolean' });
  }
  if (body.error !== undefined && typeof body.error !== 'string') {
    return json(400, { error: 'error must be a string' });
  }

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: body.success ? 'done' : 'error',
    result: body.success ? (body.result ?? null) : null,
    error: body.success ? null : (body.error ?? 'unknown_error'),
    completed_at: nowIso,
    updated_at: nowIso,
  };

  const { data, error } = await admin
    .from('edge_jobs')
    .update(patch)
    .eq('id', body.job_id)
    .eq('workstation_id', wsId)
    .in('status', ['in_progress', 'queued'])
    .select('id, status')
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!data) return json(409, { error: 'job_not_claimable' });
  return json(200, { ok: true });
});
