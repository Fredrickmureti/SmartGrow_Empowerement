// AccrualFlow Edge — agent completion route.
// Moved verbatim from edge-agent-complete/index.ts.

import { admin, json, sha256Hex } from '../_shared.ts';

interface CompleteBody {
  job_id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function handle(req: Request): Promise<Response> {
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
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body.job_id || typeof body.job_id !== 'string') return json(400, { error: 'job_id required' });
  if (typeof body.success !== 'boolean') return json(400, { error: 'success must be a boolean' });
  if (body.error !== undefined && typeof body.error !== 'string') return json(400, { error: 'error must be a string' });

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
}
