// AccrualFlow Edge — workstation registration
//
// An authenticated org member creates a workstation record. The raw secret
// is returned ONCE in this response; only its SHA-256 hash is persisted.
// The desktop agent stores that raw secret in its local config and uses it
// as a bearer token when polling `edge-agent-poll` and posting results via
// `edge-agent-complete`.
//
// Phase 2 scaffolding — Phase 4 replaces this with an interactive enrolment
// wizard that mints a workstation-bound JWT.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

interface RegisterBody {
  organization_id: string;
  name: string;
}

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
  // URL-safe base64
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

  let body: RegisterBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const orgId = (body.organization_id ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!orgId || !name) return json(400, { error: 'organization_id and name required' });
  if (name.length > 120) return json(400, { error: 'name too long' });

  // Verify caller is a member of the org (RLS on user_organizations enforces this).
  const { data: orgs } = await userClient.rpc('get_user_organizations', {
    _user_id: userData.user.id,
  });
  const ok = Array.isArray(orgs) && orgs.some((row: { organization_id?: string } | string) =>
    typeof row === 'string' ? row === orgId : row?.organization_id === orgId,
  );
  if (!ok) return json(403, { error: 'not_a_member_of_organization' });

  const secret = randomSecret();
  const secretHash = await sha256Hex(secret);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: inserted, error: insertErr } = await admin
    .from('workstations')
    .insert({ organization_id: orgId, name, secret_hash: secretHash })
    .select('id, organization_id, name, created_at')
    .single();
  if (insertErr) return json(500, { error: insertErr.message });

  return json(200, {
    workstation: inserted,
    // The raw secret is returned once. Client should show it to the operator
    // and drop it into `~/.accrualflow/edge/workstation.json` on the workstation.
    secret,
    supabase_url: SUPABASE_URL,
  });
});
