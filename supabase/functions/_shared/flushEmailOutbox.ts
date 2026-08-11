/**
 * Email event-outbox flusher.
 *
 * Mirrors flushSmsOutbox.ts: drains queued rows from `email_event_outbox`,
 * resolves recipients, and dispatches via the existing `send-email` edge
 * function. One place that talks to the email provider.
 *
 * Recipient resolution strategy (in order):
 *   1. Explicit row `recipient_email` wins (manual / per-event override).
 *   2. Otherwise, fan out to org admins/owners/super_admins whose
 *      `notification_preferences` for the event's category have email_enabled
 *      (default true if no prefs row). This mirrors how `send-stock-alert-email`
 *      already resolves inventory recipients, so users get email coverage
 *      without any new configuration.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const OUTBOX_BATCH = 25;
const MAX_ATTEMPTS = 3;

interface FlushResult {
  outboxProcessed: number;
  outboxSent: number;
}

interface OutboxRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  recipient_email: string | null;
  recipient_user_id: string | null;
  template_variables: Record<string, unknown> | null;
  attempts: number | null;
}

/** Map an event type to the notification_preferences `category` row. */
function categoryForEvent(eventType: string): string {
  if (eventType === "out_of_stock" || eventType === "low_stock_alert") return "inventory";
  if (eventType.startsWith("invoice")) return "billing";
  if (eventType.startsWith("payment")) return "billing";
  return "general";
}

async function resolveEmailRecipients(
  supabase: SupabaseClient,
  row: OutboxRow,
): Promise<string[]> {
  // 1) Explicit override
  if (row.recipient_email) return [row.recipient_email];

  // 2) Specific user
  if (row.recipient_user_id) {
    const { data } = await supabase
      .from("profiles")
      .select("email")
      .eq("user_id", row.recipient_user_id)
      .maybeSingle();
    return data?.email ? [data.email] : [];
  }

  // 3) Org admins/owners with email_enabled for the relevant category
  const category = categoryForEvent(row.event_type);

  const { data: roles } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("organization_id", row.organization_id)
    .eq("is_active", true)
    .in("role", ["owner", "admin", "super_admin"]);
  const userIds = (roles || []).map((r: { user_id: string }) => r.user_id);
  if (userIds.length === 0) return [];

  const { data: prefs } = await supabase
    .from("notification_preferences")
    .select("user_id, email_enabled")
    .eq("organization_id", row.organization_id)
    .eq("category", category)
    .in("user_id", userIds);
  const prefsMap = new Map<string, boolean>();
  for (const p of (prefs || []) as Array<{ user_id: string; email_enabled: boolean | null }>) {
    prefsMap.set(p.user_id, p.email_enabled !== false);
  }

  const enabledUserIds = userIds.filter((u) => prefsMap.get(u) ?? true);
  if (enabledUserIds.length === 0) return [];

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, email")
    .in("user_id", enabledUserIds);
  return (profiles || [])
    .map((p: { email: string | null }) => p.email)
    .filter((e: string | null): e is string => !!e);
}

function renderInventoryEmail(eventType: string, vars: Record<string, unknown>): { subject: string; html: string } {
  const productName = String(vars.product_name ?? "Product");
  const sku = String(vars.sku ?? "");
  const stock = String(vars.stock_quantity ?? "0");
  const reorder = String(vars.reorder_level ?? "");
  const isOOS = eventType === "out_of_stock";
  const subject = isOOS
    ? `Out of Stock: ${productName}`
    : `Low Stock Alert: ${productName} (${stock} remaining)`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:#f9fafb;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 12px;color:${isOOS ? "#dc2626" : "#f59e0b"};font-size:20px;">
          ${isOOS ? "⛔ Out of Stock" : "⚠️ Low Stock Alert"}
        </h2>
        <p style="margin:0 0 16px;color:#111827;font-size:15px;">
          <strong>${productName}</strong>${sku ? ` (SKU: ${sku})` : ""}
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
          <tr><td style="padding:6px 0;color:#6b7280;">Current stock</td><td style="text-align:right;font-weight:600;color:${isOOS ? "#dc2626" : "#f59e0b"};">${stock}</td></tr>
          ${reorder ? `<tr><td style="padding:6px 0;color:#6b7280;">Reorder level</td><td style="text-align:right;">${reorder}</td></tr>` : ""}
        </table>
        <p style="color:#6b7280;font-size:13px;margin:16px 0 0;">
          ${isOOS ? "This product is unavailable for sale until restocked." : "Consider creating a purchase order soon."}
        </p>
      </div>
      <p style="color:#9ca3af;font-size:11px;margin:16px 0 0;text-align:center;">
        Automated alert from your ERP. Manage notification preferences in Settings → Notifications.
      </p>
    </div>
  `;
  return { subject, html };
}

/** PO release → supplier: branded order notification (replaces the generic var dump). */
function renderPurchaseOrderEmail(vars: Record<string, unknown>): { subject: string; html: string } {
  const poNumber = String(vars.po_number ?? "");
  const fmtDate = (v: unknown): string => {
    if (!v) return "—";
    const d = new Date(String(v));
    return isNaN(d.getTime())
      ? String(v)
      : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  };
  const orderDate = fmtDate(vars.order_date);
  const expectedDate = fmtDate(vars.expected_date);
  const currency = String(vars.currency ?? "");
  const totalNum = Number(vars.total ?? NaN);
  const total = isNaN(totalNum)
    ? "—"
    : `${currency} ${totalNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

  const subject = `Purchase Order ${poNumber}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:#f9fafb;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 12px;color:#1d4ed8;font-size:20px;">Purchase Order ${poNumber}</h2>
        <p style="margin:0 0 16px;color:#111827;font-size:15px;">You have received a new purchase order.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
          <tr><td style="padding:6px 0;color:#6b7280;">Order date</td><td style="text-align:right;font-weight:600;">${orderDate}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Expected delivery</td><td style="text-align:right;font-weight:600;">${expectedDate}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Order total</td><td style="text-align:right;font-weight:700;">${total}</td></tr>
        </table>
        <p style="color:#6b7280;font-size:13px;margin:16px 0 0;">
          Please review this order and acknowledge receipt through the supplier portal. Contact the buyer if any line, price, or date needs to be discussed.
        </p>
      </div>
      <p style="color:#9ca3af;font-size:11px;margin:16px 0 0;text-align:center;">
        Reference: ${poNumber}
      </p>
    </div>
  `;
  return { subject, html };
}

function renderEmail(eventType: string, vars: Record<string, unknown>): { subject: string; html: string } {
  if (eventType === "purchase_order_released") {
    return renderPurchaseOrderEmail(vars);
  }
  if (eventType === "out_of_stock" || eventType === "low_stock_alert") {
    return renderInventoryEmail(eventType, vars);
  }
  // Generic fallback
  const subject = `Notification: ${eventType.replace(/_/g, " ")}`;
  const html = `<div style="font-family:sans-serif;padding:24px;"><h3>${subject}</h3><pre>${JSON.stringify(vars, null, 2)}</pre></div>`;
  return { subject, html };
}

export async function flushEmailOutbox(
  supabaseUrl: string,
  serviceKey: string,
): Promise<FlushResult> {
  const supabase = createClient(supabaseUrl, serviceKey);
  const result: FlushResult = { outboxProcessed: 0, outboxSent: 0 };
  const nowIso = new Date().toISOString();

  // Recover stuck rows (mirrors SMS flusher)
  try {
    await supabase.rpc("email_outbox_recover_stuck", { p_older_than_minutes: 10 });
  } catch (e) {
    console.warn("[flushEmailOutbox] recover_stuck threw:", (e as Error).message);
  }

  const { data: rows } = await supabase
    .from("email_event_outbox")
    .select("*")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("created_at", { ascending: true })
    .limit(OUTBOX_BATCH);

  for (const row of (rows || []) as OutboxRow[]) {
    result.outboxProcessed++;

    const { error: claimErr } = await supabase
      .from("email_event_outbox")
      .update({ status: "processing", attempts: (row.attempts || 0) + 1 })
      .eq("id", row.id)
      .eq("status", "queued");
    if (claimErr) continue;

    const recipients = await resolveEmailRecipients(supabase, row);
    if (recipients.length === 0) {
      await supabase.from("email_event_outbox").update({
        status: "skipped",
        last_error: "No email recipients configured for this event",
        processed_at: nowIso,
      }).eq("id", row.id);
      continue;
    }

    const vars = row.template_variables || {};
    const { subject, html } = renderEmail(row.event_type, vars);

    let anyOk = false;
    let lastErr: string | null = null;
    for (const to of recipients) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ to, subject, html }),
        });
        const body = await resp.json().catch(() => ({}));
        if (resp.ok && (body.success || body.id)) {
          anyOk = true;
          result.outboxSent++;
        } else {
          lastErr = body.error || `send-email returned ${resp.status}`;
        }
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }

    if (anyOk) {
      await supabase.from("email_event_outbox").update({
        status: "sent",
        processed_at: nowIso,
        last_error: lastErr ? `Partial: ${lastErr}` : null,
      }).eq("id", row.id);
    } else {
      const isFinal = (row.attempts || 0) + 1 >= MAX_ATTEMPTS;
      await supabase.from("email_event_outbox").update({
        status: isFinal ? "failed" : "queued",
        last_error: lastErr,
        next_attempt_at: isFinal ? null : new Date(Date.now() + 5 * 60_000).toISOString(),
        processed_at: isFinal ? nowIso : null,
      }).eq("id", row.id);
    }
  }

  return result;
}
