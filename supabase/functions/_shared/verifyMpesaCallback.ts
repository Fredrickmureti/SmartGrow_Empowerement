/**
 * Per-tenant M-Pesa callback authenticator.
 *
 * Each organization stores its own callback secret in
 *   payment_provider_configs.config.callback_secret
 * (for provider `mpesa` for STK push, `mpesa_c2b` for Paybill/Till).
 *
 * The org operator registers callback URLs with Safaricom that embed their
 * secret as `?key=<callback_secret>` (or `X-Callback-Key` header). This
 * helper resolves the inbound key back to the owning organization. If no
 * config matches, the request is rejected (401) — preventing forged
 * payment notifications from being auto-posted.
 *
 * We compare against DB-stored, user-supplied secrets so credentials can be
 * rotated per tenant without code changes and never live in env/source.
 */

// deno-lint-ignore no-explicit-any
type Supa = any;

export interface MpesaCallerContext {
  organizationId: string;
  config: Record<string, unknown>;
}

export async function authenticateMpesaCallback(
  req: Request,
  supabase: Supa,
  provider: "mpesa" | "mpesa_c2b",
): Promise<{ ok: true; ctx: MpesaCallerContext } | { ok: false; response: Response }> {
  const url = new URL(req.url);
  const presented =
    url.searchParams.get("key") ?? req.headers.get("x-callback-key") ?? "";

  if (!presented) {
    return { ok: false, response: unauthorized("Missing callback key") };
  }

  // Pull active configs for this provider and match in-process to allow a
  // constant-time compare. Volume here is tiny (one row per tenant per
  // provider) so this is fine.
  const { data: configs, error } = await supabase
    .from("payment_provider_configs")
    .select("organization_id, config")
    .eq("provider", provider)
    .eq("is_active", true);

  if (error) {
    console.error("[mpesa-auth] config lookup failed:", error.message);
    return { ok: false, response: unauthorized("Lookup failed") };
  }

  for (const row of configs ?? []) {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const secret = typeof cfg.callback_secret === "string" ? cfg.callback_secret : "";
    if (secret && timingSafeEqual(presented, secret)) {
      return {
        ok: true,
        ctx: { organizationId: row.organization_id, config: cfg },
      };
    }
  }

  console.warn("[mpesa-auth] no matching tenant for presented callback key");
  return { ok: false, response: unauthorized("Invalid callback key") };
}

function unauthorized(desc: string): Response {
  return new Response(
    JSON.stringify({ ResultCode: 1, ResultDesc: desc }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
