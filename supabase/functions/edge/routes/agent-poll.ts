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

  const nowIso = new Date().toISOString();

  await admin
    .from('workstations')
    .update({ last_seen_at: nowIso, version: version ?? undefined })
    .eq('id', auth.workstationId);

  const { error: expireErr } = await admin.rpc('edge_jobs_expire_stale');
  if (expireErr) {
    console.warn('agent_poll.expire_stale_failed', expireErr.message);
  }

  // Batch drain: a burst of invoices used to be claimed one job per 1.5s poll
  // round-trip, so the last job in the burst expired before the agent reached
  // it. Claim up to BATCH_SIZE live jobs in one response instead.
  const BATCH_SIZE = 5;
  const jobs: unknown[] = [];

  for (let attempt = 0; attempt < BATCH_SIZE * 2 && jobs.length < BATCH_SIZE; attempt += 1) {
    const { data: candidate, error: candidateErr } = await admin
      .from('edge_jobs')
      .select('id')
      .eq('workstation_id', auth.workstationId)
      .eq('status', 'queued')
      .gt('deadline_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateErr) return json(500, { error: `candidate_failed: ${candidateErr.message}` });
    if (!candidate) break;

    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from('edge_jobs')
      .update({ status: 'in_progress', claimed_at: claimIso, updated_at: claimIso })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .gt('deadline_at', claimIso)
      .select('id, role, op, payload, idempotency_key, deadline_at, created_at')
      .maybeSingle();
    if (claimErr) return json(500, { error: `claim_failed: ${claimErr.message}` });
    if (claimed) jobs.push(claimed);
  }

  // `job` is kept for older agents that read a single job per poll.
  return json(200, { job: jobs[0] ?? null, jobs });
}
