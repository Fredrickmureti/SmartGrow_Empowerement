/**
 * SMS event-outbox flusher and retry processor.
 *
 * Called from `process-scheduled-automations` on every cron tick.
 * Idempotently dispatches:
 *   1. queued rows in `sms_event_outbox` (events fired by DB triggers)
 *   2. queued rows in `sms_log` whose `next_retry_at` has passed (Twilio 5xx/429)
 *
 * Both paths converge on the existing `send-sms` edge function so we keep
 * exactly one place that talks to Twilio.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeE164 } from "./sms/phone.ts";

const OUTBOX_BATCH = 25;
const RETRY_BATCH = 25;
const MAX_ATTEMPTS = 3;

interface FlushResult {
  outboxProcessed: number;
  outboxSent: number;
  retryProcessed: number;
  retrySent: number;
}

/**
 * Resolve all configured recipients (primary + groups + roles + custom phones)
 * for an outbox row by delegating to the canonical SQL resolver.
 * Falls back to recipient_phone if explicitly set on the outbox row.
 *
 * Phones are normalized to E.164. When the resolver returns a national-format
 * number (e.g. "0712345678"), we re-normalize using the business's country
 * before discarding it. As a last-resort fallback, when the outbox row points
 * at a contact (recipient_contact_id) and nothing else resolved a phone, we
 * look up contacts.phone directly so contact-scoped events (invoice_posted,
 * payment_received, …) still send.
 */
async function resolveAllRecipients(
  supabase: SupabaseClient,
  row: {
    organization_id: string;
    business_id: string | null;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    recipient_phone: string | null;
    recipient_contact_id: string | null;
  },
): Promise<Array<{ phone: string; recipient_kind: string; source: string }>> {
  // Resolve the org/business default country once for normalization fallbacks
  let defaultCountry: string | undefined;
  if (row.business_id) {
    const { data: biz } = await supabase
      .from("businesses")
      .select("country")
      .eq("id", row.business_id)
      .maybeSingle();
    defaultCountry = (biz?.country as string | undefined)?.toUpperCase();
  }

  const tryNormalize = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    return normalizeE164(raw) ?? normalizeE164(raw, defaultCountry) ?? null;
  };

  const out: Array<{ phone: string; recipient_kind: string; source: string }> = [];
  const seen = new Set<string>();
  const push = (phone: string | null, kind: string, source: string) => {
    if (!phone) return;
    if (seen.has(phone)) return;
    seen.add(phone);
    out.push({ phone, recipient_kind: kind, source });
  };

  // Explicit per-row phone wins (used by manual triggerSmsEvent paths)
  if (row.recipient_phone) {
    push(tryNormalize(row.recipient_phone), "explicit", "outbox_row");
  }

  const { data, error } = await supabase.rpc("resolve_rule_recipients", {
    p_org_id: row.organization_id,
    p_event: row.event_type,
    p_entity_type: row.entity_type,
    p_entity_id: row.entity_id,
    p_primary_contact_id: row.recipient_contact_id,
    p_primary_phone: null,
  });
  if (error) {
    console.error("[flushSmsOutbox] resolve_rule_recipients error:", error);
  } else {
    for (const r of (data || []) as Array<{ phone: string; recipient_kind: string; source: string }>) {
      push(tryNormalize(r.phone), r.recipient_kind, r.source);
    }
  }

  // Last-resort fallback: look up the contact's phone directly so
  // contact-scoped events still send when no rule recipients are configured
  // or when the resolver couldn't normalize the contact's phone.
  if (out.length === 0 && row.recipient_contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone")
      .eq("id", row.recipient_contact_id)
      .maybeSingle();
    push(tryNormalize(contact?.phone as string | null | undefined), "contact", "contact_fallback");
  }

  return out;
}

export async function flushSmsOutbox(
  supabaseUrl: string,
  serviceKey: string,
): Promise<FlushResult> {
  const supabase = createClient(supabaseUrl, serviceKey);
  const result: FlushResult = { outboxProcessed: 0, outboxSent: 0, retryProcessed: 0, retrySent: 0 };
  const nowIso = new Date().toISOString();

  // ── 0. Recover rows stuck in `processing` (e.g. function crashed mid-claim).
  //    Without this they pile up forever and silently block the queue from view.
  try {
    const { data: recovered, error: recoverErr } = await supabase
      .rpc("sms_outbox_recover_stuck", { p_older_than_minutes: 10 });
    if (recoverErr) {
      console.warn("[flushSmsOutbox] recover_stuck error:", recoverErr.message);
    } else if (typeof recovered === "number" && recovered > 0) {
      console.log(`[flushSmsOutbox] recovered ${recovered} stuck rows`);
    }
  } catch (e) {
    console.warn("[flushSmsOutbox] recover_stuck threw:", (e as Error).message);
  }

  // ── 1. Outbox ──
  const { data: outboxRows } = await supabase
    .from("sms_event_outbox")
    .select("*")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("created_at", { ascending: true })
    .limit(OUTBOX_BATCH);

  for (const row of outboxRows || []) {
    result.outboxProcessed++;
    // Mark processing first so a parallel run can't double-send
    const { error: claimErr } = await supabase
      .from("sms_event_outbox")
      .update({ status: "processing", attempts: (row.attempts || 0) + 1 })
      .eq("id", row.id)
      .eq("status", "queued");
    if (claimErr) continue;

    const recipients = await resolveAllRecipients(supabase, row);
    if (recipients.length === 0) {
      await supabase.from("sms_event_outbox").update({
        status: "skipped",
        last_error: "No recipient configured for this rule",
        processed_at: nowIso,
      }).eq("id", row.id);
      continue;
    }

    let anyOk = false;
    let lastErr: string | null = null;
    for (const rcpt of recipients) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            organization_id: row.organization_id,
            business_id: row.business_id,
            event_type: row.event_type,
            recipient_phone: rcpt.phone,
            template_variables: row.template_variables || {},
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            triggered_by: "automation",
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (body.success) {
          anyOk = true;
          result.outboxSent++;
        } else {
          lastErr = body.message || body.error || "send-sms returned failure";
        }
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }

    if (anyOk) {
      await supabase.from("sms_event_outbox").update({
        status: "sent", processed_at: nowIso,
        last_error: lastErr ? `Partial: ${lastErr}` : null,
      }).eq("id", row.id);
    } else {
      const isFinal = (row.attempts || 0) + 1 >= MAX_ATTEMPTS;
      await supabase.from("sms_event_outbox").update({
        status: isFinal ? "failed" : "queued",
        last_error: lastErr,
        next_attempt_at: isFinal ? null : new Date(Date.now() + 5 * 60_000).toISOString(),
        processed_at: isFinal ? nowIso : null,
      }).eq("id", row.id);
    }
  }

  // ── 2. Retry queued sms_log rows ──
  const { data: retryRows } = await supabase
    .from("sms_log")
    .select("id, organization_id, business_id, event_type, recipient_phone, message_body, retry_count")
    .eq("status", "queued")
    .lte("next_retry_at", nowIso)
    .lt("retry_count", MAX_ATTEMPTS)
    .order("next_retry_at", { ascending: true })
    .limit(RETRY_BATCH);

  for (const row of retryRows || []) {
    result.retryProcessed++;
    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          organization_id: row.organization_id,
          business_id: row.business_id,
          event_type: row.event_type,
          recipient_phone: row.recipient_phone,
          custom_message: row.message_body,
          retry_of_log_id: row.id,
          triggered_by: "retry",
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (body.success) result.retrySent++;
    } catch (e) {
      console.error("[flushSmsOutbox] retry error:", e);
    }
  }

  return result;
}
