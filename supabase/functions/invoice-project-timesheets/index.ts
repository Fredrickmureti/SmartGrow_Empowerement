// @ts-nocheck
/**
 * invoice-project-timesheets
 *
 * Input: { project_id, period_from?: "YYYY-MM-DD", period_to?: "YYYY-MM-DD" }
 * Picks approved + billable + not-yet-invoiced timesheets for the project in
 * the period, drafts ONE invoice (status="draft") with one line per (employee,
 * task, billing_rate), links each timesheet via mark_timesheets_invoiced RPC.
 *
 * GL posting is intentionally NOT done here — confirming the draft invoice
 * via the existing Sales/Invoices flow runs the canonical posting RPC.
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
  project_id: z.string().uuid(),
  period_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

  // Resolve caller (audits)
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

  // Load project (org/business/customer/currency/branch)
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, name, organization_id, business_id, branch_id, customer_id, currency")
    .eq("id", body.project_id)
    .single();
  if (pErr || !project) {
    return new Response(JSON.stringify({ error: "project_not_found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!(project as any).customer_id) {
    return new Response(JSON.stringify({ error: "project_has_no_customer" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Pull project default + member overrides for fallback rate resolution
  const { data: projectFull } = await supabase
    .from("projects")
    .select("default_billable_rate")
    .eq("id", body.project_id)
    .single();
  const projectDefaultRate = Number((projectFull as any)?.default_billable_rate ?? 0);

  const { data: members } = await supabase
    .from("project_members")
    .select("user_id, billable_rate")
    .eq("project_id", body.project_id);
  const memberRateByUserId = new Map<string, number>();
  for (const m of (members ?? []) as any[]) {
    if (m.user_id != null && m.billable_rate != null) {
      memberRateByUserId.set(m.user_id, Number(m.billable_rate));
    }
  }

  let q = supabase
    .from("timesheets")
    .select("id, employee_id, task_id, hours, billing_rate, billing_amount, description, date")
    .eq("project_id", body.project_id)
    .eq("is_billable", true)
    .eq("status", "approved")
    .or("is_invoiced.is.null,is_invoiced.eq.false");
  if (body.period_from) q = q.gte("date", body.period_from);
  if (body.period_to) q = q.lte("date", body.period_to);

  const { data: ts, error: tErr } = await q;
  if (tErr) {
    return new Response(JSON.stringify({ error: tErr.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!ts || ts.length === 0) {
    return new Response(JSON.stringify({ ok: true, invoice_id: null, lines: 0, message: "no_billable_timesheets" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Build employee.user_id map for member-rate lookup
  const empIds = Array.from(new Set((ts as any[]).map((t) => t.employee_id).filter(Boolean)));
  const employeeUserIdById = new Map<string, string | null>();
  if (empIds.length > 0) {
    const { data: emps } = await supabase
      .from("employees")
      .select("id, user_id")
      .in("id", empIds);
    for (const e of (emps ?? []) as any[]) employeeUserIdById.set(e.id, e.user_id ?? null);
  }

  // Group lines by (employee, task, effective rate)
  const groups = new Map<string, { employee_id: string | null; task_id: string | null; rate: number; hours: number; amount: number; ids: string[] }>();
  for (const t of ts as any[]) {
    const userId = t.employee_id ? employeeUserIdById.get(t.employee_id) ?? null : null;
    const tsRate = t.billing_rate != null ? Number(t.billing_rate) : null;
    const memberRate = userId ? memberRateByUserId.get(userId) ?? null : null;
    const rate = tsRate ?? memberRate ?? projectDefaultRate ?? 0;
    const hours = Number(t.hours ?? 0);
    const amount = t.billing_amount != null ? Number(t.billing_amount) : hours * rate;
    const k = `${t.employee_id ?? ""}|${t.task_id ?? ""}|${rate}`;
    const g = groups.get(k) ?? { employee_id: t.employee_id, task_id: t.task_id, rate, hours: 0, amount: 0, ids: [] };
    g.hours += hours;
    g.amount += amount;
    g.ids.push(t.id);
    groups.set(k, g);
  }

  const subtotal = Array.from(groups.values()).reduce((s, g) => s + g.amount, 0);

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
      subtotal,
      tax_amount: 0,
      total: subtotal,
      currency: (project as any).currency || "USD",
      notes: `Timesheet billing for project ${(project as any).name}` +
        (body.period_from || body.period_to ? ` (${body.period_from ?? "…"} → ${body.period_to ?? "…"})` : ""),
      created_by: userId,
    } as any)
    .select()
    .single();

  if (iErr || !inv) {
    return new Response(JSON.stringify({ error: iErr?.message ?? "invoice_insert_failed" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let sort = 0;
  const items = Array.from(groups.values()).map((g) => ({
    invoice_id: (inv as any).id,
    description: `Timesheet hours${g.task_id ? ` (task ${g.task_id.slice(0, 8)})` : ""}`,
    quantity: g.hours,
    unit_price: g.rate,
    tax_rate: 0,
    discount_percent: 0,
    line_total: g.amount,
    sort_order: sort++,
    project_id: body.project_id,
    task_id: g.task_id,
  }));

  const { error: itErr } = await supabase.from("invoice_items").insert(items as any);
  if (itErr) {
    return new Response(JSON.stringify({ error: itErr.message, invoice_id: (inv as any).id }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Mark all sourced timesheets as invoiced via canonical RPC.
  const allIds = (ts as any[]).map((t) => t.id);
  await supabase.rpc("mark_timesheets_invoiced", {
    _invoice_id: (inv as any).id,
    _timesheet_ids: allIds,
  } as any);

  return new Response(
    JSON.stringify({ ok: true, invoice_id: (inv as any).id, lines: items.length, hours: items.reduce((s, i) => s + i.quantity, 0), subtotal }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
