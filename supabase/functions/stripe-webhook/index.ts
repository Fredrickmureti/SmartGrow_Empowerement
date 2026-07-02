import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { activateSubscription } from "../_shared/subscriptionUtils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── Stripe Signature Verification ───────────────────────────────────────────
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const parts = signature.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.split("=")[1];
  const sig = parts.find((p) => p.startsWith("v1="))?.split("=")[1];

  if (!timestamp || !sig) return false;

  // Reject if timestamp is older than 5 minutes (replay protection)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) {
    console.error("Webhook timestamp too old:", age, "seconds");
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload)
  );
  const expectedSig = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expectedSig === sig;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    console.log("Stripe webhook received");

    // ─── Get Stripe webhook secret ───────────────────────────────────
    const { data: provider } = await supabase
      .from("platform_payment_providers")
      .select("credentials")
      .eq("provider", "stripe")
      .single();

    const credentials = provider?.credentials as {
      webhook_secret?: string;
      secret_key?: string;
    };

    // ─── Verify Signature (REQUIRED) ─────────────────────────────────
    if (!credentials?.webhook_secret || !signature) {
      console.error("Stripe webhook missing secret or signature — rejecting");
      return new Response(
        JSON.stringify({ error: "Webhook signature verification required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const valid = await verifyStripeSignature(
      body,
      signature,
      credentials.webhook_secret
    );
    if (!valid) {
      console.error("Invalid Stripe webhook signature");
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log("Stripe signature verified ✓");

    // ─── Parse Event ─────────────────────────────────────────────────
    let event;
    try {
      event = JSON.parse(body);
    } catch (err) {
      console.error("Invalid JSON:", err);
      return new Response(
        JSON.stringify({ error: "Invalid JSON" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Idempotency Check ───────────────────────────────────────────
    const eventId = event.id;
    if (eventId) {
      const { data: existing } = await supabase
        .from("webhook_events")
        .select("id")
        .eq("provider", "stripe")
        .eq("event_id", eventId)
        .maybeSingle();

      if (existing) {
        console.log(`Duplicate webhook event ${eventId} — skipping`);
        return new Response(
          JSON.stringify({ received: true, duplicate: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    console.log(`Processing Stripe event: ${event.type}`);

    let processedOrgId: string | null = null;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const { user_id, organization_id, plan_id, billing_cycle } = session.metadata || {};

        if (!organization_id || !plan_id) {
          console.error("Missing metadata in session:", session.id);
          break;
        }

        processedOrgId = organization_id;

        const amount = session.amount_total ? session.amount_total / 100 : 0;

        const result = await activateSubscription(supabase, {
          organizationId: organization_id,
          planId: plan_id,
          billingCycle: billing_cycle || "monthly",
          paymentMethod: "stripe",
          amount,
          currency: (session.currency || "usd").toUpperCase(),
          userId: user_id || null,
          notes: `Stripe checkout ${session.id}`,
        });

        // Store external IDs for lifecycle tracking
        const externalUpdate: Record<string, any> = {};
        if (session.subscription) externalUpdate.external_subscription_id = session.subscription;
        if (session.customer) externalUpdate.external_customer_id = session.customer;

        if (Object.keys(externalUpdate).length > 0) {
          await supabase
            .from("organizations")
            .update(externalUpdate)
            .eq("id", organization_id);
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        console.log(`Subscription updated: ${subscription.id}, status: ${subscription.status}`);

        const { data: org } = await supabase
          .from("organizations")
          .select("id, subscription_ends_at")
          .eq("external_subscription_id", subscription.id)
          .maybeSingle();

        if (org) {
          processedOrgId = org.id;
          const statusMap: Record<string, string> = {
            active: "active",
            past_due: "past_due",
            canceled: "cancelled",
            unpaid: "past_due",
            trialing: "trial",
          };

          const newStatus = statusMap[subscription.status] || subscription.status;
          const newEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : org.subscription_ends_at;

          await supabase
            .from("organizations")
            .update({
              subscription_status: newStatus,
              subscription_ends_at: newEnd,
              updated_at: new Date().toISOString(),
            })
            .eq("id", org.id);

          console.log(`Org ${org.id} subscription synced: status=${newStatus}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const { data: org } = await supabase
          .from("organizations")
          .select("id")
          .eq("external_subscription_id", subscription.id)
          .maybeSingle();

        if (org) {
          processedOrgId = org.id;
          await supabase
            .from("organizations")
            .update({
              subscription_status: "cancelled",
              updated_at: new Date().toISOString(),
            })
            .eq("id", org.id);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const { data: org } = await supabase
            .from("organizations")
            .select("id")
            .eq("external_subscription_id", invoice.subscription)
            .maybeSingle();

          if (org) {
            processedOrgId = org.id;
            await supabase
              .from("organizations")
              .update({
                subscription_status: "past_due",
                updated_at: new Date().toISOString(),
              })
              .eq("id", org.id);

            await supabase.from("audit_logs").insert({
              organization_id: org.id,
              entity_type: "subscription",
              entity_id: org.id,
              action: "payment_failed",
              changes_summary: `Stripe payment failed for invoice ${invoice.id}.`,
            });
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // ─── Record webhook event for idempotency ────────────────────────
    if (eventId) {
      await supabase.from("webhook_events").insert({
        provider: "stripe",
        event_id: eventId,
        event_type: event.type,
        organization_id: processedOrgId,
        payload: event,
      });
    }

    return new Response(
      JSON.stringify({ received: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in stripe-webhook:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
