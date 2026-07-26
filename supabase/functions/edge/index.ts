// AccrualFlow Edge — consolidated router.
//
// One deployed function that dispatches on the trailing path segment so
// we stay under the project's Edge Function ceiling. Route modules keep
// the same auth model, request/response shapes, and DB writes as the
// six former standalone functions (edge-workstation-*, edge-agent-*).
//
// Routes:
//   POST /functions/v1/edge/workstation/register
//   POST /functions/v1/edge/workstation/rotate-secret
//   POST /functions/v1/edge/workstation/manifest
//   GET  /functions/v1/edge/workstation/origins
//   POST /functions/v1/edge/agent/poll
//   POST /functions/v1/edge/agent/complete

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { handle as workstationRegister } from './routes/workstation-register.ts';
import { handle as workstationRotateSecret } from './routes/workstation-rotate-secret.ts';
import { handle as workstationManifest } from './routes/workstation-manifest.ts';
import { handle as workstationOrigins } from './routes/workstation-origins.ts';
import { handle as agentPoll } from './routes/agent-poll.ts';
import { handle as agentComplete } from './routes/agent-complete.ts';

type Handler = (req: Request) => Promise<Response>;

const ROUTES: Record<string, { method: string; handle: Handler }> = {
  'workstation/register':      { method: 'POST', handle: workstationRegister },
  'workstation/rotate-secret': { method: 'POST', handle: workstationRotateSecret },
  'workstation/manifest':      { method: 'POST', handle: workstationManifest },
  'workstation/origins':       { method: 'GET',  handle: workstationOrigins },
  'agent/poll':                { method: 'POST', handle: agentPoll },
  'agent/complete':            { method: 'POST', handle: agentComplete },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function extractSubpath(pathname: string): string {
  // Supabase invokes this function at /edge/... — strip everything up to and
  // including the function name so route keys are transport-agnostic.
  const idx = pathname.indexOf('/edge');
  if (idx < 0) return '';
  let rest = pathname.slice(idx + '/edge'.length);
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  return rest;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const sub = extractSubpath(new URL(req.url).pathname);
  const route = ROUTES[sub];
  if (!route) return json(404, { code: 'NOT_FOUND', message: `unknown route: ${sub}` });
  if (route.method !== req.method) return json(405, { error: 'method_not_allowed' });

  try {
    return await route.handle(req);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { error: message });
  }
});
