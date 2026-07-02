import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeE164 } from "../_shared/sms/phone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Twilio's official keyword lists.
 * Sources:
 *  - https://help.twilio.com/articles/223134027 (STOP/HELP/START)
 *  - Twilio Messaging Policy.
 * Twilio handles these at the carrier level for US long codes/short codes,
 * but for international + toll-free + long-code-non-US we MUST honor them ourselves.
 */
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES", "OPTIN", "OPT-IN"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

/** TwiML response — Twilio sends the reply directly without a second API call. */
function twimlReply(message: string): Response {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
  return new Response(xml, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } });
}
function twimlEmpty(): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
}

async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  const sortedKeys = Object.keys(params).sort();
  let dataString = url;
  for (const key of sortedKeys) dataString += key + params[key];

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(dataString));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  return computed === signature;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((v, k) => { params[k] = v as string; });

    const messageSid = params.MessageSid;
    const messageStatus = params.MessageStatus;
    const inboundFrom = params.From;
    const inboundTo = params.To;
    const inboundBody = params.Body;

    // Distinguish: delivery callback (has MessageStatus) vs inbound message (has Body+From, no MessageStatus)
    const isDeliveryCallback = !!messageStatus;
    const isInbound = !messageStatus && !!inboundFrom && !!inboundTo && inboundBody !== undefined;

    if (!isDeliveryCallback && !isInbound) {
      return new Response("Missing fields", { status: 400 });
    }

    // ── Look up org + auth_token to validate signature ──
    let orgId: string | null = null;
    let authToken: string | null = null;
    let helpMessage: string | null = null;
    let inboundEnabled = true;

    if (isDeliveryCallback) {
      const { data: logEntry } = await supabaseAdmin
        .from("sms_log").select("organization_id")
        .eq("provider_message_id", messageSid).maybeSingle();
      orgId = logEntry?.organization_id ?? null;
    } else if (isInbound) {
      // Inbound: prefer MessagingServiceSid match (Messaging Service deployments),
      // then fall back to the configured sender_phone equality.
      const inboundMsid = params.MessagingServiceSid;
      const normalizedTo = normalizeE164(inboundTo) ?? inboundTo;

      let cfg: { organization_id: string; auth_token: string; help_message: string; inbound_enabled: boolean } | null = null;

      if (inboundMsid) {
        const { data } = await supabaseAdmin
          .from("sms_provider_configs")
          .select("organization_id, auth_token, help_message, inbound_enabled")
          .eq("messaging_service_sid", inboundMsid)
          .limit(1).maybeSingle();
        cfg = data ?? null;
      }
      if (!cfg) {
        const { data } = await supabaseAdmin
          .from("sms_provider_configs")
          .select("organization_id, auth_token, help_message, inbound_enabled")
          .eq("sender_phone", normalizedTo)
          .limit(1).maybeSingle();
        cfg = data ?? null;
      }
      if (!cfg) {
        console.warn("[sms-webhook] inbound: no org found for To=", inboundTo, "MSID=", inboundMsid);
        return twimlEmpty();
      }
      orgId = cfg.organization_id;
      authToken = cfg.auth_token;
      helpMessage = cfg.help_message;
      inboundEnabled = cfg.inbound_enabled;
    }

    if (orgId && !authToken) {
      const { data: cfg } = await supabaseAdmin
        .from("sms_provider_configs")
        .select("auth_token, help_message, inbound_enabled")
        .eq("organization_id", orgId).limit(1).maybeSingle();
      authToken = cfg?.auth_token ?? null;
      helpMessage = helpMessage ?? cfg?.help_message ?? null;
      inboundEnabled = cfg?.inbound_enabled ?? true;
    }

    // ── Signature validation ──
    const signature = req.headers.get("X-Twilio-Signature");
    if (!signature) {
      console.error("[sms-webhook] Missing X-Twilio-Signature");
      return new Response("Missing signature", { status: 403 });
    }
    if (!authToken) {
      console.error("[sms-webhook] No auth token configured for org; rejecting unverifiable callback");
      return new Response("Signature verification unavailable", { status: 403 });
    }
    {
      const fullUrl = new URL(req.url).toString();
      const valid = await validateTwilioSignature(authToken, signature, fullUrl, params);
      if (!valid) {
        console.error("[sms-webhook] Invalid Twilio signature");
        return new Response("Invalid signature", { status: 403 });
      }
    }

    // ============================================================
    // DELIVERY STATUS CALLBACK
    // ============================================================
    if (isDeliveryCallback) {
      const statusMap: Record<string, string> = {
        queued: "queued", sent: "sent", delivered: "delivered",
        failed: "failed", undelivered: "undelivered",
      };
      const mapped = statusMap[messageStatus] || messageStatus;
      const updates: Record<string, unknown> = { status: mapped };
      if (mapped === "delivered") updates.delivered_at = new Date().toISOString();
      if (params.ErrorCode) updates.error_code = params.ErrorCode;
      if (params.ErrorMessage) updates.error_message = params.ErrorMessage;
      await supabaseAdmin.from("sms_log").update(updates).eq("provider_message_id", messageSid);
      return new Response("OK", { status: 200 });
    }

    // ============================================================
    // INBOUND MESSAGE
    // ============================================================
    if (isInbound && orgId) {
      const normalizedFrom = normalizeE164(inboundFrom) ?? inboundFrom;
      const trimmed = (inboundBody || "").trim().toUpperCase();

      // Always log the inbound message
      await supabaseAdmin.from("sms_log").insert({
        organization_id: orgId,
        recipient_phone: inboundTo,
        from_phone: normalizedFrom,
        message_body: inboundBody || "",
        status: "delivered",
        provider_mode: "live",
        provider_message_id: messageSid ?? null,
        direction: "inbound",
        sent_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
      });

      if (!inboundEnabled) return twimlEmpty();

      // STOP family
      if (STOP_KEYWORDS.has(trimmed)) {
        await supabaseAdmin.from("sms_opt_outs").upsert({
          organization_id: orgId,
          phone_number: normalizedFrom,
          reason: `inbound: ${trimmed}`,
        }, { onConflict: "organization_id,phone_number" });
        return twimlReply("You have been unsubscribed and will receive no further messages. Reply START to resubscribe.");
      }

      // START family
      if (START_KEYWORDS.has(trimmed)) {
        await supabaseAdmin.from("sms_opt_outs")
          .delete()
          .eq("organization_id", orgId)
          .eq("phone_number", normalizedFrom);
        return twimlReply("You have been resubscribed. Reply STOP to unsubscribe at any time.");
      }

      // HELP family
      if (HELP_KEYWORDS.has(trimmed)) {
        return twimlReply(helpMessage || "Reply STOP to unsubscribe.");
      }

      // Anything else: acknowledge silently (no auto-reply to avoid loops)
      return twimlEmpty();
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("sms-webhook error:", error);
    return new Response("Error", { status: 500 });
  }
});
