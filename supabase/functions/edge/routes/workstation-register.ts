// AccrualFlow Edge — workstation registration route.
// Moved verbatim from edge-workstation-register/index.ts (Phase consolidation).

import { admin, json, randomSecret, sha256Hex, SUPABASE_URL, userClientFor } from '../_shared.ts';

interface RegisterBody {
  organization_id: string;
  name: string;
}

export async function handle(req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'missing_authorization' });

  const userClient = userClientFor(authHeader);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'invalid_session' });

  let body: RegisterBody;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const orgId = (body.organization_id ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!orgId || !name) return json(400, { error: 'organization_id and name required' });
  if (name.length > 120) return json(400, { error: 'name too long' });

  const { data: orgs } = await userClient.rpc('get_user_organizations', {
    _user_id: userData.user.id,
  });
  const ok = Array.isArray(orgs) && orgs.some((row: { organization_id?: string } | string) =>
    typeof row === 'string' ? row === orgId : row?.organization_id === orgId,
  );
  if (!ok) return json(403, { error: 'not_a_member_of_organization' });

  const secret = randomSecret();
  const secretHash = await sha256Hex(secret);

  const { data: inserted, error: insertErr } = await admin
    .from('workstations')
    .insert({ organization_id: orgId, name, secret_hash: secretHash })
    .select('id, organization_id, name, created_at')
    .single();
  if (insertErr) return json(500, { error: insertErr.message });

  return json(200, {
    workstation: inserted,
    secret,
    supabase_url: SUPABASE_URL,
  });
}
