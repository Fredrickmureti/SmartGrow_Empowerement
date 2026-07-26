// AccrualFlow Edge — agent poll route.
// Moved verbatim from edge-agent-poll/index.ts.

import { admin, authorizeWorkstation, json } from '../_shared.ts';

export async function handle(req: Request): Promise<Response> {
  const auth = await authorizeWorkstation(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let version: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.version === 'string') version = body.version.slice(0, 40);
  } catch { /* ignore */ }

  await admin
    .from('workstations')
    .update({ last_seen_at: new Date().toISOString(), version: version ?? undefined })
    .eq('id', auth.workstationId);

  await admin.rpc('edge_jobs_expire_stale').catch(() => undefined);

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
      .eq('status', 'queued')
      .select('id, role, op, payload, idempotency_key, deadline_at, created_at')
      .maybeSingle();
    if (claimErr) return json(500, { error: claimErr.message });
    if (claimed) return json(200, { job: claimed });
  }
  return json(200, { job: null });
}
