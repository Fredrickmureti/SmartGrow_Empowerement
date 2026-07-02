// @ts-nocheck - Tables not in auto-generated types
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RecurringInvoice {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  template_name: string;
  notes: string | null;
  terms: string | null;
  currency: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  next_run_date: string;
  last_run_date: string | null;
  end_date: string | null;
  is_active: boolean;
  auto_send: boolean;
  days_before_due: number;
  invoices_generated: number;
  items: Array<{
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price: number;
    tax_rate: number;
    discount_percent: number;
    sort_order: number;
  }>;
  contact: { name: string; email: string | null } | null;
}

interface AccountMappings {
  accounts_receivable_id: string | null;
  sales_revenue_id: string | null;
  output_tax_account_id: string | null;
}

// ─── Calendar-safe next-run-date ───────────────────────────────────────────

function calculateNextRunDate(frequency: string, fromDate: Date): string {
  const originalDay = fromDate.getDate();
  const date = new Date(fromDate);

  switch (frequency) {
    case "weekly":
      date.setDate(date.getDate() + 7);
      break;
    case "biweekly":
      date.setDate(date.getDate() + 14);
      break;
    case "monthly":
      date.setMonth(date.getMonth() + 1);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
    case "quarterly":
      date.setMonth(date.getMonth() + 3);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
    case "yearly":
      date.setFullYear(date.getFullYear() + 1);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
  }

  return date.toISOString().split("T")[0];
}

// ─── Fetch default GL account mappings server-side ─────────────────────────

const MAPPING_KEY_MAP: Record<string, string> = {
  cash: "cash_account_id",
  accounts_receivable: "accounts_receivable_id",
  sales_revenue: "sales_revenue_id",
  output_tax: "output_tax_account_id",
};

async function fetchAccountMappings(
  supabase: any,
  orgId: string,
  businessId: string | null
): Promise<AccountMappings> {
  const result: AccountMappings = {
    accounts_receivable_id: null,
    sales_revenue_id: null,
    output_tax_account_id: null,
  };

  // 1. Explicit settings (highest priority)
  const { data: settings } = await supabase
    .from("default_account_settings")
    .select("setting_key, account_id")
    .eq("organization_id", orgId)
    .in("setting_key", ["accounts_receivable", "sales_revenue", "output_tax"]);

  if (settings) {
    for (const s of settings as unknown as Array<{ setting_key: string; account_id: string }>) {
      const field = MAPPING_KEY_MAP[s.setting_key];
      if (field) (result as any)[field] = s.account_id;
    }
  }

  // 2. (Legacy default_account_mappings table dropped — settings above are the
  // single source of truth. Heuristic fallback below covers older orgs.)

  // 3. Heuristic fallback: match by name/code
  if (!result.accounts_receivable_id || !result.sales_revenue_id) {
    const { data: accounts } = await supabase
      .from("accounts")
      .select("id, name, code, account_type")
      .eq("organization_id", orgId)
      .eq("is_active", true);

    if (accounts) {
      for (const a of accounts as unknown as Array<{ id: string; name: string; code: string; account_type: string }>) {
        const nameLower = a.name.toLowerCase();
        if (!result.accounts_receivable_id && a.account_type === "asset" && nameLower.includes("receivable")) {
          result.accounts_receivable_id = a.id;
        }
        if (!result.sales_revenue_id && a.account_type === "income" && (nameLower.includes("sales") || nameLower.includes("revenue"))) {
          result.sales_revenue_id = a.id;
        }
        if (!result.output_tax_account_id && a.account_type === "liability" && (nameLower.includes("tax") || nameLower.includes("vat"))) {
          result.output_tax_account_id = a.id;
        }
      }
    }
  }

  return result;
}

// ─── Calculate totals with discounts ───────────────────────────────────────

function calculateTotals(items: RecurringInvoice["items"]) {
  let subtotal = 0;
  let taxAmount = 0;

  for (const item of items) {
    const discountedLine = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
    subtotal += discountedLine;
    taxAmount += discountedLine * (item.tax_rate / 100);
  }

  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

// ─── Build invoice line items with discounts ───────────────────────────────

function buildInvoiceItems(items: RecurringInvoice["items"], invoiceId: string) {
  return items.map((item) => {
    const discountedLineTotal = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
    return {
      invoice_id: invoiceId,
      product_id: item.product_id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: discountedLineTotal * (item.tax_rate / 100),
      discount_percent: item.discount_percent,
      line_total: discountedLineTotal,
      sort_order: item.sort_order,
    };
  });
}

// ─── Post GL journal entry for an invoice ──────────────────────────────────

async function postInvoiceGL(
  supabase: ReturnType<typeof createClient>,
  invoice: { id: string; invoice_number: string; issue_date: string; subtotal: number; tax_amount: number; total: number; contact_id: string | null },
  orgId: string,
  businessId: string | null,
  branchId: string | null,
  accountMappings: AccountMappings
): Promise<string | null> {
  if (!accountMappings.accounts_receivable_id || !accountMappings.sales_revenue_id) {
    console.warn(`[GL] Skipping GL posting for ${invoice.invoice_number}: missing AR or Revenue account mappings`);
    return null;
  }

  // Idempotency: check if JE already exists for this invoice
  const { data: existing } = await supabase
    .from("journal_entries")
    .select("id")
    .eq("organization_id", orgId)
    .eq("source_type", "invoice")
    .eq("source_id", invoice.id)
    .neq("status", "voided")
    .maybeSingle();

  if (existing) {
    console.log(`[GL] JE already exists for invoice ${invoice.invoice_number}: ${(existing as any).id}`);
    return (existing as any).id;
  }

  // Get next JE number
  const { data: entryNumber, error: numErr } = await supabase.rpc("get_next_journal_entry_number", { _org_id: orgId } as any);
  if (numErr) {
    console.error(`[GL] Failed to get JE number:`, numErr);
    return null;
  }

  // Build GL lines: DR AR, CR Revenue, CR Tax (if applicable)
  const lines: Array<{ account_id: string; debit: number; credit: number; description: string }> = [
    {
      account_id: accountMappings.accounts_receivable_id,
      debit: invoice.total,
      credit: 0,
      description: `Invoice ${invoice.invoice_number} - Accounts Receivable`,
    },
    {
      account_id: accountMappings.sales_revenue_id,
      debit: 0,
      credit: invoice.subtotal,
      description: `Invoice ${invoice.invoice_number} - Sales Revenue`,
    },
  ];

  if (invoice.tax_amount > 0 && accountMappings.output_tax_account_id) {
    lines.push({
      account_id: accountMappings.output_tax_account_id,
      debit: 0,
      credit: invoice.tax_amount,
      description: `Invoice ${invoice.invoice_number} - Tax Liability`,
    });
  }

  // Call the atomic RPC
  const { data: jeId, error: rpcError } = await supabase.rpc("post_journal_entry_atomic", {
    _org_id: orgId,
    _business_id: businessId,
    _branch_id: branchId,
    _entry_number: entryNumber,
    _entry_date: invoice.issue_date,
    _reference: invoice.invoice_number,
    _description: `Invoice ${invoice.invoice_number} confirmed (recurring)`,
    _source_type: "invoice",
    _source_id: invoice.id,
    _created_by: null,
    _is_closing: false,
    _is_adjusting: false,
    _lines: lines,
  } as any);

  if (rpcError) {
    console.error(`[GL] RPC error posting JE for ${invoice.invoice_number}:`, rpcError);
    return null;
  }

  return jeId as string;
}

// ─── Generate a single invoice from a recurring template ───────────────────

async function generateSingleInvoice(
  supabase: any,
  ri: RecurringInvoice,
  issueDate: string,
  accountMappings: AccountMappings
): Promise<{ invoiceNumber: string; invoiceId: string } | null> {
  // Get next invoice number
  const { data: invoiceNumber, error: numError } = await supabase.rpc(
    "get_next_invoice_number",
    { _org_id: ri.organization_id } as any
  );
  if (numError) throw numError;

  // Calculate due date
  const dueDate = new Date(issueDate);
  dueDate.setDate(dueDate.getDate() + ri.days_before_due);

  // Calculate totals with discounts
  const items = ri.items || [];
  const { subtotal, taxAmount, total } = calculateTotals(items);

  // Create invoice — status "confirmed" since we'll post GL
  const hasGLAccounts = !!(accountMappings.accounts_receivable_id && accountMappings.sales_revenue_id);
  const invoiceStatus = hasGLAccounts ? "confirmed" : (ri.auto_send ? "sent" : "draft");

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      organization_id: ri.organization_id,
      business_id: ri.business_id,
      // Recurring rules carry the branch dimension. Generated invoices MUST
      // inherit the template's branch_id — NEVER the runtime caller's branch
      // (cron has no caller context). Without this, recurring invoices
      // surface under HQ even when the rule was created under a branch,
      // contaminating per-branch AR aging and GL.
      branch_id: ri.branch_id ?? null,
      contact_id: ri.contact_id,
      invoice_number: invoiceNumber,
      status: invoiceStatus,
      issue_date: issueDate,
      due_date: dueDate.toISOString().split("T")[0],
      subtotal,
      tax_amount: taxAmount,
      total,
      currency: ri.currency,
      notes: ri.notes,
      terms: ri.terms,
    } as any)
    .select()
    .single();

  if (invoiceError) throw invoiceError;

  const inv = invoice as any;

  // Copy items with discount-aware calculations
  if (items.length > 0) {
    const invoiceItems = buildInvoiceItems(items, inv.id);
    const { error: itemsError } = await supabase.from("invoice_items").insert(invoiceItems as any);
    if (itemsError) {
      console.error(`[process-recurring-invoices] Error creating invoice items:`, itemsError);
    }
  }

  // Post GL entry
  if (hasGLAccounts) {
    const jeId = await postInvoiceGL(
      supabase,
      { id: inv.id, invoice_number: invoiceNumber as string, issue_date: issueDate, subtotal, tax_amount: taxAmount, total, contact_id: ri.contact_id },
      ri.organization_id,
      ri.business_id,
      ri.branch_id ?? null,
      accountMappings
    );

    if (jeId) {
      // Link JE to invoice
      await supabase.from("invoices").update({ journal_entry_id: jeId } as any).eq("id", inv.id);
    } else {
      // GL posting failed — revert to draft so it's visible as needing attention
      await supabase.from("invoices").update({ status: "draft" } as any).eq("id", inv.id);
    }
  }

  // Auto-send email if enabled
  if (ri.auto_send && ri.contact?.email) {
    try {
      await supabase.functions.invoke("send-invoice", {
        body: {
          invoiceId: inv.id,
          recipientEmail: ri.contact.email,
          recipientName: ri.contact.name,
        },
      });
      console.log(`[process-recurring-invoices] Sent invoice ${invoiceNumber} to ${ri.contact.email}`);
      // Update status to sent if it was confirmed
      await supabase.from("invoices").update({ status: "sent" } as any).eq("id", inv.id);
    } catch (sendError) {
      console.error(`[process-recurring-invoices] Failed to send invoice:`, sendError);
    }
  }

  // Notification
  await supabase.from("notifications").insert({
    organization_id: ri.organization_id,
    type: "invoice",
    title: "Recurring Invoice Generated",
    message: `Invoice ${invoiceNumber} was automatically generated from recurring template "${ri.template_name}"`,
    link: `/sales/invoices?id=${inv.id}`,
    priority: "medium",
  } as any);

  // SMS — recurring_invoice_generated
  const phone = ri.contact?.mobile || ri.contact?.phone;
  if (phone) {
    try {
      const { triggerSmsEvent } = await import("../_shared/triggerSmsEvent.ts");
      await triggerSmsEvent(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        {
          organization_id: ri.organization_id,
          business_id: (ri as { business_id?: string | null }).business_id ?? null,
          event_type: "recurring_invoice_generated",
          recipient_phone: phone,
          template_variables: {
            invoice_number: invoiceNumber as string,
            amount: String((inv as { total?: number }).total ?? ""),
            customer_name: ri.contact?.name || "",
          },
        },
      );
    } catch (e) {
      console.error("[process-recurring-invoices] SMS trigger error:", e);
    }
  }


  return { invoiceNumber: invoiceNumber as string, invoiceId: inv.id };
}

// ─── Main handler ──────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase: any = createClient(supabaseUrl, supabaseServiceKey);
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");

    const today = new Date().toISOString().split("T")[0];
    console.log(`[process-recurring-invoices] Starting processing for date: ${today}`);

    // Fetch all active recurring invoices with next_run_date <= today
    const { data: recurringInvoices, error: fetchError } = await supabase
      .from("recurring_invoices")
      .select(`
        *,
        items:recurring_invoice_items(*),
        contact:contacts(name, email)
      `)
      .eq("is_active", true)
      .lte("next_run_date", today);

    if (fetchError) {
      console.error("[process-recurring-invoices] Fetch error:", fetchError);
      throw fetchError;
    }

    console.log(`[process-recurring-invoices] Found ${recurringInvoices?.length || 0} recurring invoices to process`);

    const results: Array<{ id: string; status: string; invoicesGenerated?: number; error?: string }> = [];

    // Cache account mappings per organization to avoid repeated queries
    const accountMappingsCache: Record<string, AccountMappings> = {};

    for (const ri of (recurringInvoices || []) as RecurringInvoice[]) {
      try {
        // ── Subscription check: skip if org subscription is not active ──
        const subCheck = await checkSubscriptionActive(supabase, ri.organization_id);
        if (!subCheck.allowed) {
          console.log(`[process-recurring-invoices] Skipping ${ri.id} — org ${ri.organization_id} subscription not active: ${subCheck.reason}`);
          results.push({ id: ri.id, status: "skipped", error: `Subscription not active: ${subCheck.reason}` });
          // Notify platform admin
          await supabase.from("platform_admin_alerts").insert({
            alert_type: "background_job_skipped",
            severity: "warning",
            title: `Recurring invoice skipped: ${ri.template_name || ri.id}`,
            details: { function: "process-recurring-invoices", reason: subCheck.reason, recurring_invoice_id: ri.id },
            organization_id: ri.organization_id,
          });
          continue;
        }

        // ── Deactivate if end_date passed ──
        if (ri.end_date && new Date(ri.end_date) < new Date(today)) {
          console.log(`[process-recurring-invoices] Deactivating ${ri.id} — end date passed`);
          await supabase.from("recurring_invoices").update({ is_active: false } as any).eq("id", ri.id);
          results.push({ id: ri.id, status: "deactivated", error: "End date passed" });
          continue;
        }

        // ── Duplicate protection: skip if last_run_date >= next_run_date ──
        if (ri.last_run_date && ri.last_run_date >= ri.next_run_date) {
          console.log(`[process-recurring-invoices] Skipping ${ri.id} — already processed (last_run: ${ri.last_run_date}, next_run: ${ri.next_run_date})`);
          results.push({ id: ri.id, status: "skipped", error: "Already processed" });
          continue;
        }

        // ── Fetch account mappings (cached per org) ──
        if (!accountMappingsCache[ri.organization_id]) {
          accountMappingsCache[ri.organization_id] = await fetchAccountMappings(supabase, ri.organization_id, ri.business_id);
        }
        const accountMappings = accountMappingsCache[ri.organization_id];

        // ── Catch-up loop: generate all missed invoices ──
        let currentNextRun = ri.next_run_date;
        let invoicesThisRun = 0;
        const maxCatchUp = 12; // Safety: don't generate more than 12 at once

        while (currentNextRun <= today && invoicesThisRun < maxCatchUp) {
          // Check end_date within the loop
          if (ri.end_date && currentNextRun > ri.end_date) {
            await supabase.from("recurring_invoices").update({ is_active: false } as any).eq("id", ri.id);
            break;
          }

          const result = await generateSingleInvoice(supabase, ri, currentNextRun, accountMappings);
          if (result) {
            console.log(`[process-recurring-invoices] Created invoice ${result.invoiceNumber} for date ${currentNextRun}`);
          }

          invoicesThisRun++;

          // Advance next_run_date from the *current* scheduled date (not from today)
          const advancedDate = calculateNextRunDate(ri.frequency, new Date(currentNextRun));

          // Update DB atomically after each generation
          await supabase
            .from("recurring_invoices")
            .update({
              last_run_date: currentNextRun,
              next_run_date: advancedDate,
              invoices_generated: ri.invoices_generated + invoicesThisRun,
            } as any)
            .eq("id", ri.id);

          currentNextRun = advancedDate;
        }

        if (invoicesThisRun > 0) {
          results.push({ id: ri.id, status: "success", invoicesGenerated: invoicesThisRun });
        }
      } catch (error) {
        console.error(`[process-recurring-invoices] Error processing ${ri.id}:`, error);
        results.push({ id: ri.id, status: "error", error: String(error) });
      }
    }

    console.log(`[process-recurring-invoices] Completed. Results:`, results);

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("[process-recurring-invoices] Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
