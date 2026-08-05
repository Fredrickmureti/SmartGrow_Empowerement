// AccrualFlow Edge — agent poll route.
// Moved verbatim from edge-agent-poll/index.ts.

import { admin, authorizeWorkstation, json } from '../_shared.ts';

/** Upper bound on how long one poll request may be held open. */
const MAX_WAIT_MS = 20_000;
/** How often the held-open poll re-checks for newly queued jobs. */
const RECHECK_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claim up to `limit` live queued jobs for this workstation. */
async function claimBatch(
  workstationId: string,
  limit: number,
): Promise<{ jobs: unknown[]; error?: string }> {
  const jobs: unknown[] = [];
  for (let attempt = 0; attempt < limit * 2 && jobs.length < limit; attempt += 1) {
    const { data: candidate, error: candidateErr } = await admin
      .from('edge_jobs')
      .select('id')
      .eq('workstation_id', workstationId)
      .eq('status', 'queued')
      .gt('deadline_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateErr) return { jobs, error: `candidate_failed: ${candidateErr.message}` };
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
    if (claimErr) return { jobs, error: `claim_failed: ${claimErr.message}` };
    if (claimed) jobs.push(claimed);
  }
  return { jobs };
}

export async function handle(req: Request): Promise<Response> {
  const auth = await authorizeWorkstation(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let version: string | undefined;
  let waitMs = 0;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.version === 'string') version = body.version.slice(0, 40);
    // Long-poll window requested by the agent. Older agents omit it and keep
    // the original fire-and-return behaviour.
    if (body && Number.isFinite(body.wait_ms)) {
      waitMs = Math.min(Math.max(0, Number(body.wait_ms)), MAX_WAIT_MS);
    }
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

  const first = await claimBatch(auth.workstationId, BATCH_SIZE);
  if (first.error) return json(500, { error: first.error });
  jobs.push(...first.jobs);

  // Long poll: hold the connection instead of returning empty and making the
  // agent wait a full client-side poll interval. With a 1.5 s client poll the
  // average claim latency was ~750 ms of pure dead time on the cashier's
  // clock; re-checking every RECHECK_MS inside the request cuts it to ~125 ms
  // while *reducing* the number of round trips.
  if (jobs.length === 0 && waitMs > 0) {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(RECHECK_MS);
      const claimed = await claimBatch(auth.workstationId, BATCH_SIZE);
      if (claimed.error) return json(500, { error: claimed.error });
      if (claimed.jobs.length > 0) {
        jobs.push(...claimed.jobs);
        break;
      }
    }
  }

  // `job` is kept for older agents that read a single job per poll.
  return json(200, { job: jobs[0] ?? null, jobs });
}
