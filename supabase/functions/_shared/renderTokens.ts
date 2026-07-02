// @ts-nocheck — Deno runtime; npm: specifiers and Deno globals are not in the browser tsconfig.
/**
 * renderTokens — single resolver for localization-pack template bodies.
 *
 * All payslip / certificate / statutory-return / remittance bodies are
 * stored as block JSON whose `content` strings carry token references like
 * `{{employee.full_name}}` or `{{run.period_end}}`. This module is the ONE
 * place that resolves those references at runtime so:
 *
 *   1. unresolved tokens always show the same `‹unresolved: token›` sentinel
 *      (matches the editor preview),
 *   2. every miss is recorded in `payroll_diagnostics` so admins can spot
 *      drift after a pack upgrade,
 *   3. engines stay free of literal rule_code switches.
 *
 * Keep this file zero-dependency on the engines so it stays portable.
 */
// Note: the supabase-js client is dynamically imported inside
// `renderAndDiagnose` so this module stays loadable from non-Deno test
// runners (vitest) that only exercise the pure resolver helpers.
type SupabaseClient = any;

type TokenContext = Record<string, any>;

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Resolve a dotted path against a context object. Returns undefined on miss. */
export function lookup(ctx: TokenContext, path: string): unknown {
  return path.split(".").reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), ctx);
}

/**
 * Render a single string by substituting `{{token.path}}` references from
 * `ctx`. Missing tokens are replaced with the sentinel and pushed into
 * `misses` for downstream diagnostics.
 */
export function renderString(input: string, ctx: TokenContext, misses: string[]): string {
  return input.replace(TOKEN_RE, (_m, token) => {
    const v = lookup(ctx, token);
    if (v === undefined || v === null) {
      misses.push(token);
      return `‹unresolved: ${token}›`;
    }
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

/**
 * Recursively render every string field of a template body.
 * Returns `{ rendered, misses }`. The original body is not mutated.
 */
export function renderTokens<T = any>(body: T, ctx: TokenContext): { rendered: T; misses: string[] } {
  const misses: string[] = [];
  const walk = (node: any): any => {
    if (node == null) return node;
    if (typeof node === "string") return renderString(node, ctx, misses);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const out: Record<string, any> = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k]);
      return out;
    }
    return node;
  };
  return { rendered: walk(body) as T, misses };
}

/**
 * Render + persist a diagnostic row when any token went unresolved.
 * Pass a service-role client so the insert bypasses RLS; never call this
 * with a tenant-scoped client.
 */
export async function renderAndDiagnose<T = any>(
  body: T,
  ctx: TokenContext,
  opts: {
    serviceClient?: SupabaseClient;
    organization_id?: string | null;
    pack_id?: string | null;
    template_code?: string | null;
    surface: "payslip" | "certificate" | "statutory_return" | "remittance" | string;
  },
): Promise<{ rendered: T; misses: string[] }> {
  const result = renderTokens(body, ctx);
  if (result.misses.length === 0) return result;

  // Dynamic import keeps this file loadable from vitest (browser tsconfig)
  // while still working under Deno at runtime.
  let sb = opts.serviceClient;
  if (!sb) {
    // @vite-ignore — Deno-only specifier; vitest never reaches this branch
    // because it always passes `serviceClient` or never invokes
    // renderAndDiagnose. Inline `/* @vite-ignore */` keeps Vite from trying
    // to resolve `npm:` at build time.
    const spec = "npm:@supabase/supabase-js@2";
    const { createClient } = await import(/* @vite-ignore */ spec);
    sb = createClient(
      (globalThis as any).Deno?.env.get("SUPABASE_URL") ?? "",
      (globalThis as any).Deno?.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
  }

  try {
    await (sb as any).from("payroll_diagnostics").insert({
      organization_id: opts.organization_id ?? null,
      pack_id: opts.pack_id ?? null,
      template_code: opts.template_code ?? null,
      surface: opts.surface,
      severity: "warning",
      code: "TOKEN_UNRESOLVED",
      message: `Unresolved tokens: ${Array.from(new Set(result.misses)).join(", ")}`,
      details: { tokens: result.misses },
    });
  } catch {
    // diagnostics must never break rendering
  }
  return result;
}
