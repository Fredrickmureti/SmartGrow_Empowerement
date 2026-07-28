/**
 * Shared helper to authenticate cron-triggered edge functions.
 *
 * pg_cron / external schedulers MUST invoke these functions with the
 * `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` header. Any other
 * caller is rejected with 401.
 *
 * Constant-time compare to avoid trivial token discovery via timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function requireCronAuth(req: Request): Response | null {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronToken = Deno.env.get("CRON_CALLER_JWT") ?? "";
  if (!serviceKey && !cronToken) {
    return new Response(
      JSON.stringify({ error: "server_misconfigured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const header = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  const ok =
    !!token &&
    ((serviceKey && constantTimeEqual(token, serviceKey)) ||
      (cronToken && constantTimeEqual(token, cronToken)));
  if (!ok) {
    return new Response(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}
