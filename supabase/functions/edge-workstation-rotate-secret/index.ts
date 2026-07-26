// AccrualFlow Edge — workstation secret rotation.
//
// Called by the desktop shell's Auth tab. An org member rotates the shared
// secret for one of the org's workstations. The old hash is overwritten in
// the same UPDATE (atomic) and the new raw secret is returned exactly once.
// The desktop app must immediately re-write ~/.accrualflow/edge/workstation.json
// or the workstation will fall out of the relay on next poll.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'missing_authorization' });

  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'invalid_session' });

  let body: { workstation_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const wsId = (body.workstation_id ?? '').trim();
  if (!wsId) return json(400, { error: 'workstation_id required' });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: ws, error: fetchErr } = await admin
    .from('workstations')
    .select('id, organization_id, name')
    .eq('id', wsId)
    .maybeSingle();
  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!ws) return json(404, { error: 'workstation_not_found' });

  // Membership check against the workstation's org.
  const { data: orgs } = await userClient.rpc('get_user_organizations', {
    _user_id: userData.user.id,
  });
  const ok = Array.isArray(orgs) && orgs.some((row: { organization_id?: string } | string) =>
    typeof row === 'string' ? row === ws.organization_id : row?.organization_id === ws.organization_id,
  );
  if (!ok) return json(403, { error: 'not_a_member_of_organization' });

  const secret = randomSecret();
  const secret_hash = await sha256Hex(secret);
  const { error: updErr } = await admin
    .from('workstations')
    .update({ secret_hash, secret_rotated_at: new Date().toISOString() })
    .eq('id', wsId);
  if (updErr) return json(500, { error: updErr.message });

  return json(200, { workstation_id: wsId, secret, supabase_url: SUPABASE_URL });
});
