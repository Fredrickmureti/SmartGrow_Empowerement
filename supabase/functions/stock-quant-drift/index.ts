// Nightly drift check: compares stock_quants vs legacy warehouse_stock
// per (business, product, warehouse) and records a run row via
// public.record_stock_quant_drift_run. Precondition for retiring
// warehouse_stock (ADR 0075, followup ADR 0076).
//
// Called by pg_cron with the anon key in the Authorization header;
// verify_jwt is disabled — we validate the shared key in code.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";

interface DriftRow {
  business_id: string;
  product_id: string;
  warehouse_id: string;
  quant_qty: number;
  legacy_qty: number;
  diff: number;
}

const BodySchema = z.object({
  organization_id: z.string().uuid().optional(),
});

const PAGE = 500;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Shared-key guard — pg_cron sends the anon key; reject anything else.
  const auth = req.headers.get("Authorization") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  if (auth !== `Bearer ${anonKey}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await req.json().catch(() => ({})));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Resolve orgs — either the caller's one, or every active org.
  const orgIds = parsed.organization_id
    ? [parsed.organization_id]
    : await listActiveOrgs(admin);

  const summaries: Array<Record<string, unknown>> = [];
  for (const orgId of orgIds) {
    summaries.push(await runForOrg(admin, orgId));
  }

  return json({ ok: true, orgs: summaries.length, summaries });
});

async function listActiveOrgs(admin: ReturnType<typeof createClient>): Promise<string[]> {
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .is("deleted_at", null);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function runForOrg(
  admin: ReturnType<typeof createClient>,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();

  let productsChecked = 0;
  let driftedRows = 0;
  let totalDrift = 0;
  const sample: DriftRow[] = [];

  try {
    // Page through products for this org.
    let from = 0;
    while (true) {
      const { data: products, error: pErr } = await admin
        .from("products")
        .select("id")
        .eq("organization_id", organizationId)
        .range(from, from + PAGE - 1);
      if (pErr) throw pErr;
      if (!products || products.length === 0) break;

      const ids = products.map((p: { id: string }) => p.id);
      productsChecked += ids.length;

      // Both aggregates for this page.
      const [quantsRes, legacyRes] = await Promise.all([
        admin
          .from("stock_quants")
          .select("business_id, product_id, warehouse_id, quantity")
          .eq("organization_id", organizationId)
          .in("product_id", ids),
        admin
          .from("warehouse_stock")
          .select("business_id, product_id, warehouse_id, quantity")
          .eq("organization_id", organizationId)
          .in("product_id", ids),
      ]);
      if (quantsRes.error) throw quantsRes.error;
      if (legacyRes.error) throw legacyRes.error;

      const quantMap = new Map<string, number>();
      for (const r of (quantsRes.data ?? []) as Array<{
        business_id: string; product_id: string; warehouse_id: string; quantity: number;
      }>) {
        const k = `${r.business_id}|${r.product_id}|${r.warehouse_id}`;
        quantMap.set(k, (quantMap.get(k) ?? 0) + Number(r.quantity || 0));
      }
      const legacyMap = new Map<string, number>();
      for (const r of (legacyRes.data ?? []) as Array<{
        business_id: string; product_id: string; warehouse_id: string; quantity: number;
      }>) {
        const k = `${r.business_id}|${r.product_id}|${r.warehouse_id}`;
        legacyMap.set(k, (legacyMap.get(k) ?? 0) + Number(r.quantity || 0));
      }

      const keys = new Set([...quantMap.keys(), ...legacyMap.keys()]);
      for (const k of keys) {
        const q = quantMap.get(k) ?? 0;
        const l = legacyMap.get(k) ?? 0;
        const diff = q - l;
        if (Math.abs(diff) > 0.0001) {
          driftedRows += 1;
          totalDrift += Math.abs(diff);
          if (sample.length < 10) {
            const [business_id, product_id, warehouse_id] = k.split("|");
            sample.push({ business_id, product_id, warehouse_id, quant_qty: q, legacy_qty: l, diff });
          }
        }
      }

      if (products.length < PAGE) break;
      from += PAGE;
    }

    const { error: recErr } = await admin.rpc("record_stock_quant_drift_run", {
      p_organization_id: organizationId,
      p_products_checked: productsChecked,
      p_drifted_rows: driftedRows,
      p_total_drift_qty: totalDrift,
      p_sample_drift: sample,
      p_duration_ms: Date.now() - startedAt,
      p_status: "completed",
      p_error_message: null,
    });
    if (recErr) throw recErr;

    return {
      organization_id: organizationId,
      status: "completed",
      products_checked: productsChecked,
      drifted_rows: driftedRows,
      total_drift_qty: totalDrift,
      duration_ms: Date.now() - startedAt,
    };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    await admin.rpc("record_stock_quant_drift_run", {
      p_organization_id: organizationId,
      p_products_checked: productsChecked,
      p_drifted_rows: driftedRows,
      p_total_drift_qty: totalDrift,
      p_sample_drift: sample,
      p_duration_ms: Date.now() - startedAt,
      p_status: "failed",
      p_error_message: message,
    });
    return { organization_id: organizationId, status: "failed", error: message };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
