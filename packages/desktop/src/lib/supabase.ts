/**
 * Zero-dependency Supabase client for the desktop shell.
 *
 * We deliberately avoid `@supabase/supabase-js` here because:
 *   1. Every dependency we ship widens the installer surface;
 *   2. The desktop app only needs three operations — auth, invoke an edge
 *      function, and a couple of table reads — and each of those is a
 *      single `fetch` call against a documented URL shape.
 *
 * Session tokens live in-memory only (no `localStorage`) — the enrolment
 * secret is the durable credential and lives on disk with mode 0600.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

interface Session { access_token: string; refresh_token: string; user: { id: string; email: string | null } }

let session: Session | null = null;
export function currentSession(): Session | null { return session; }

async function req(path: string, init: RequestInit & { auth?: boolean } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('apikey', SUPABASE_ANON_KEY);
  headers.set('Content-Type', 'application/json');
  if (init.auth !== false) {
    headers.set('Authorization', session ? `Bearer ${session.access_token}` : `Bearer ${SUPABASE_ANON_KEY}`);
  }
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error((body as { error_description?: string; msg?: string; error?: string })?.error_description
    ?? (body as { msg?: string })?.msg
    ?? (body as { error?: string })?.error
    ?? `${res.status} ${res.statusText}`);
  return body as any;
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const body = await req('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  session = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    user: { id: body.user.id, email: body.user.email ?? null },
  };
  return session;
}

export function signOut() { session = null; }

/** Invoke an edge function. Throws on non-2xx. */
export async function invoke<T = unknown>(fn: string, payload: unknown): Promise<T> {
  return req(`/functions/v1/${fn}`, { method: 'POST', body: JSON.stringify(payload) }) as Promise<T>;
}

/** Simple table read via PostgREST. Selects/filters as raw querystrings. */
export async function select<T = unknown>(table: string, qs = ''): Promise<T[]> {
  return req(`/rest/v1/${table}${qs ? `?${qs}` : ''}`, { method: 'GET' }) as Promise<T[]>;
}

/** Organizations the signed-in user belongs to (RPC exposed by the main app). */
export async function listMyOrganizations(): Promise<{ organization_id: string; name?: string }[]> {
  if (!session) return [];
  const rows = await req('/rest/v1/rpc/get_user_organizations', {
    method: 'POST',
    body: JSON.stringify({ _user_id: session.user.id }),
  });
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => typeof row === 'string'
    ? { organization_id: row }
    : (row as { organization_id: string; name?: string }));
}
