// TEMPORARY diagnostic driver for the UoM/packaging lifecycle simulation.
// Signs in as an existing org user (admin magic-link -> verifyOtp) and then
// replays the exact RPC/table calls the app's UI makes, under that user's RLS.
// Delete after the audit.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PIN = "sim-4d1f9c2a-uom-audit";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    const body = await req.json();
    if (body.pin !== PIN) return new Response("no", { status: 403, headers: cors });

    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: body.email,
    });
    if (linkErr) throw linkErr;
    const hashed = (link as any).properties.hashed_token;

    const user = createClient(url, anon, { auth: { persistSession: false } });
    const { data: sess, error: otpErr } = await user.auth.verifyOtp({
      type: "magiclink",
      token_hash: hashed,
    });
    if (otpErr) throw otpErr;

    const results: unknown[] = [];
    const vars: Record<string, unknown> = {};

    const resolve = (v: unknown): unknown => {
      if (typeof v === "string" && v.startsWith("$")) {
        const path = v.slice(1).split(".");
        let cur: any = vars;
        for (const p of path) cur = cur?.[p];
        return cur;
      }
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) out[k] = resolve(val);
        return out;
      }
      return v;
    };

    for (const step of body.steps ?? []) {
      let data: unknown = null;
      let error: unknown = null;
      try {
        if (step.op === "rpc") {
          const r = await user.rpc(step.name, resolve(step.args ?? {}) as any);
          data = r.data;
          error = r.error;
        } else if (step.op === "insert") {
          const r = await user
            .from(step.table)
            .insert(resolve(step.values) as any)
            .select(step.select ?? "*");
          data = r.data;
          error = r.error;
        } else if (step.op === "update") {
          let q: any = user.from(step.table).update(resolve(step.values) as any);
          for (const [k, v] of Object.entries(step.filters ?? {})) q = q.eq(k, resolve(v));
          const r = await q.select(step.select ?? "*");
          data = r.data;
          error = r.error;
        } else if (step.op === "select") {
          let q: any = user.from(step.table).select(step.select ?? "*");
          for (const [k, v] of Object.entries(step.filters ?? {})) q = q.eq(k, resolve(v));
          const r = await q;
          data = r.data;
          error = r.error;
        }
      } catch (e) {
        error = String(e);
      }
      if (step.as) vars[step.as] = data;
      results.push({
        id: step.id ?? step.name ?? step.table,
        ok: !error,
        error: error ? (error as any).message ?? error : null,
        data: step.quiet ? undefined : data,
      });
      if (error && step.stopOnError !== false) break;
    }

    return new Response(JSON.stringify({ user: sess.user?.id, results }, null, 2), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ fatal: String((e as Error).message ?? e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
