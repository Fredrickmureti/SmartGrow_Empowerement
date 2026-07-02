/**
 * Notify PO Confirmed Edge Function
 * 
 * When a vendor confirms a Purchase Order via the vendor portal,
 * this function:
 * 1. Creates an in-app notification for the PO creator
 * 2. Sends an email to the PO creator
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { purchase_order_id } = await req.json();

    if (!purchase_order_id) {
      return new Response(
        JSON.stringify({ error: "purchase_order_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch PO with vendor and creator details
    const { data: po, error: poError } = await supabase
      .from("purchase_orders")
      .select("id, po_number, organization_id, business_id, created_by, total, currency, vendor:contacts(name)")
      .eq("id", purchase_order_id)
      .single();

    if (poError || !po) {
      console.error("[notify-po-confirmed] PO not found:", poError);
      return new Response(
        JSON.stringify({ error: "Purchase order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Subscription entitlement: refuse writes from suspended/inactive orgs ──
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
    const subCheck = await checkSubscriptionActive(supabase, po.organization_id);
    if (!subCheck.allowed) {
      console.warn("[notify-po-confirmed] Org subscription not active:", subCheck);
      return new Response(
        JSON.stringify({ error: subCheck.reason || "Subscription not active", code: subCheck.code }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const vendorName = (po.vendor as any)?.name || "A vendor";
    const poNumber = po.po_number;
    const createdBy = po.created_by;

    // 1. Create in-app notification for the PO creator
    if (createdBy) {
      try {
        await supabase.rpc("create_notification", {
          p_user_id: createdBy,
          p_organization_id: po.organization_id,
          p_business_id: po.business_id || undefined,
          p_title: "Purchase Order Confirmed",
          p_message: `${vendorName} has confirmed ${poNumber} (${po.currency || "USD"} ${Number(po.total).toLocaleString()}).`,
          p_type: "info",
          p_category: "purchasing",
          p_entity_type: "purchase_order",
          p_entity_id: po.id,
          p_link: `/purchasing?po=${po.id}`,
        });
        console.log("[notify-po-confirmed] In-app notification created for user:", createdBy);
      } catch (notifErr) {
        console.error("[notify-po-confirmed] Failed to create notification:", notifErr);
      }
    }

    // 2. Send email to PO creator
    if (createdBy) {
      // Get creator's email from auth
      const { data: { user: creatorUser } } = await supabase.auth.admin.getUserById(createdBy);
      const creatorEmail = creatorUser?.email;

      if (creatorEmail) {
        const html = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
              <tr><td align="center">
                <table width="100%" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,.1);">
                  <tr><td style="background:linear-gradient(135deg,#22c55e,#16a34a);padding:32px;text-align:center;">
                    <h1 style="margin:0;color:#fff;font-size:24px;">✅ Purchase Order Confirmed</h1>
                  </td></tr>
                  <tr><td style="padding:40px 32px;">
                    <p style="margin:0 0 20px;color:#18181b;font-size:16px;line-height:1.6;">Hello,</p>
                    <p style="margin:0 0 24px;color:#18181b;font-size:16px;line-height:1.6;">
                      Great news! <strong style="color:#16a34a;">${vendorName}</strong> has confirmed your purchase order
                      <strong>${poNumber}</strong> with a total of <strong>${po.currency || "USD"} ${Number(po.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>.
                    </p>
                    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:0 0 24px;">
                      <p style="margin:0;color:#166534;font-size:14px;line-height:1.5;">
                        <strong>What's next?</strong><br/>
                        The vendor will now prepare and ship the goods. You can track the delivery status from your Purchasing module.
                      </p>
                    </div>
                    <p style="margin:24px 0 0;color:#71717a;font-size:14px;">
                      Log in to your dashboard to view the full purchase order details.
                    </p>
                  </td></tr>
                </table>
              </td></tr>
            </table>
          </body>
          </html>
        `;

        try {
          // Route through the shared send-email transport so tenant branding
          // (business name + reply-to) is resolved centrally. See ADR 0023.
          const { error: sendErr } = await supabase.functions.invoke("send-email", {
            body: {
              to: creatorEmail,
              subject: `${vendorName} confirmed PO ${poNumber}`,
              html,
              category: "system_notification",
              organization_id: po.organization_id,
              business_id: po.business_id ?? null,
              template_key: "notification:po_confirmed",
              recipient_user_id: createdBy,
              recipient_org_id: po.organization_id,
              metadata: { po_id: po.id, po_number: poNumber },
            },
          });
          if (sendErr) {
            console.error("[notify-po-confirmed] Email send failed:", sendErr);
          } else {
            console.log("[notify-po-confirmed] Email sent to:", creatorEmail);
          }
        } catch (emailErr) {
          console.error("[notify-po-confirmed] Email error:", emailErr);
        }
      }
    }

    // Fire-and-forget: SMS for po_sent to vendor
    try {
      const { data: vendor } = await supabase
        .from("contacts")
        .select("phone, name")
        .eq("id", (po.vendor as any)?.id || "")
        .maybeSingle();

      if (vendor?.phone) {
        const smsUrl = `${supabaseUrl}/functions/v1/send-sms`;
        fetch(smsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            organization_id: po.organization_id,
            business_id: po.business_id || null,
            event_type: "po_sent",
            recipient_phone: vendor.phone,
            template_variables: {
              vendor_name: vendor.name || "",
              po_number: poNumber,
              amount: String(Number(po.total).toFixed(2)),
            },
          }),
        }).catch((e) => console.error("[notify-po-confirmed] SMS error:", e));
      }
    } catch (smsErr) {
      console.error("[notify-po-confirmed] SMS trigger error (non-blocking):", smsErr);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[notify-po-confirmed] Error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
