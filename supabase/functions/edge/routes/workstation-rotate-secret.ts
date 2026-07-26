// AccrualFlow Edge — workstation secret rotation route.
// Moved verbatim from edge-workstation-rotate-secret/index.ts.

import { admin, json, randomSecret, sha256Hex, SUPABASE_URL, userClientFor } from '../_shared.ts';

export async function handle(req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'missing_authorization' });

  const userClient = userClientFor(authHeader);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'invalid_session' });

  let body: { workstation_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const wsId = (body.workstation_id ?? '').trim();
  if (!wsId) return json(400, { error: 'workstation_id required' });

  const { data: ws, error: fetchErr } = await admin
    .from('workstations')
    .select('id, organization_id, name')
    .eq('id', wsId)
    .maybeSingle();
  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!ws) return json(404, { error: 'workstation_not_found' });

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
}
