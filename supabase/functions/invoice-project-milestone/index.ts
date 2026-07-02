// @ts-nocheck
/**
 * invoice-project-milestone
 *
 * Input: { milestone_id }
 * Drafts ONE invoice (status="draft") for the milestone's billing_amount,
 * with a single line carrying milestone_id + project_id, then flips
 * project_milestones.is_invoiced=true / invoice_id.
 *
 * Idempotent: refuses to re-bill an already-invoiced milestone unless
 * { force: true } is passed.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const Body = z.object({
  milestone_id: z.string().uuid(),
  force: z.boolean().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
  const userId = userData?.user?.id ?? null;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid_body", detail: String(e) }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: ms, error: msErr } = await supabase
    .from("project_milestones")
    .select("id, project_id, name, billing_amount, is_invoiced, invoice_id")
    .eq("id", body.milestone_id)
    .single();
  if (msErr || !ms) {
    return new Response(JSON.stringify({ error: "milestone_not_found" }), {
      status: 404, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if ((ms as any).is_invoiced && !body.force) {
    return new Response(JSON.stringify({ error: "already_invoiced", invoice_id: (ms as any).invoice_id }), {
      status: 409, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const amount = Number((ms as any).billing_amount ?? 0);
  if (amount <= 0) {
    return new Response(JSON.stringify({ error: "milestone_billing_amount_zero_or_missing" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, name, organization_id, business_id, branch_id, customer_id, currency")
    .eq("id", (ms as any).project_id)
    .single();
  if (pErr || !project || !(project as any).customer_id) {
    return new Response(JSON.stringify({ error: "project_or_customer_missing" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: invNum } = await supabase.rpc("get_next_invoice_number", { _org_id: (project as any).organization_id } as any);
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const { data: inv, error: iErr } = await supabase
    .from("invoices")
    .insert({
      organization_id: (project as any).organization_id,
      business_id: (project as any).business_id,
      branch_id: (project as any).branch_id,
      contact_id: (project as any).customer_id,
      project_id: (project as any).id,
      invoice_number: invNum ?? `DRAFT-${Date.now()}`,
      status: "draft",
      issue_date: today,
      due_date: due,
      subtotal: amount,
      tax_amount: 0,
      total: amount,
      currency: (project as any).currency || "USD",
      notes: `Milestone billing: ${(ms as any).name}`,
      created_by: userId,
    } as any)
    .select()
    .single();

  if (iErr || !inv) {
    return new Response(JSON.stringify({ error: iErr?.message ?? "invoice_insert_failed" }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { error: itErr } = await supabase.from("invoice_items").insert([{
    invoice_id: (inv as any).id,
    description: `Milestone: ${(ms as any).name}`,
    quantity: 1,
    unit_price: amount,
    tax_rate: 0,
    discount_percent: 0,
    line_total: amount,
    sort_order: 0,
    project_id: (project as any).id,
    milestone_id: (ms as any).id,
  }] as any);
  if (itErr) {
    return new Response(JSON.stringify({ error: itErr.message, invoice_id: (inv as any).id }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  await supabase.from("project_milestones").update({
    is_invoiced: true,
    invoice_id: (inv as any).id,
  } as any).eq("id", (ms as any).id);

  return new Response(JSON.stringify({ ok: true, invoice_id: (inv as any).id, amount }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
