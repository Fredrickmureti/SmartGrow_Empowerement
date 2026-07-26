// Shared helpers for the AccrualFlow Edge router.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
export const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
export const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function userClientFor(authHeader: string) {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function authorizeWorkstation(req: Request): Promise<
  | { ok: true; workstationId: string; organizationId: string; secretRotatedAt: string | null }
  | { ok: false; status: number; error: string }
> {
  const auth = req.headers.get('Authorization') ?? '';
  const wsId = req.headers.get('X-Workstation-Id') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secret) return { ok: false, status: 401, error: 'missing_bearer' };
  if (!wsId) return { ok: false, status: 400, error: 'missing_workstation_id' };
  const hash = await sha256Hex(secret);
  const { data, error } = await admin
    .from('workstations')
    .select('id, organization_id, secret_hash, secret_rotated_at')
    .eq('id', wsId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: 'db_error' };
  if (!data) return { ok: false, status: 404, error: 'workstation_not_found' };
  if (data.secret_hash !== hash) return { ok: false, status: 401, error: 'invalid_secret' };
  return {
    ok: true,
    workstationId: data.id,
    organizationId: data.organization_id,
    secretRotatedAt: (data.secret_rotated_at as string | null) ?? null,
  };
}
