import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[send-stock-alert-email] Checking for low stock items to email management...");

    // Get products below reorder level across all orgs
    const { data: lowStockProducts, error: productError } = await supabase
      .from("products")
      .select(`
        id, name, sku, stock_quantity, reorder_level,
        organization_id, business_id
      `)
      .eq("track_inventory", true)
      .not("reorder_level", "is", null)
      .filter("stock_quantity", "lte", "reorder_level");
    
    // Actually filter properly since Supabase doesn't support column-to-column comparison easily
    // We'll do it in code
    const { data: allTracked, error: allError } = await supabase
      .from("products")
      .select("id, name, sku, stock_quantity, reorder_level, organization_id, business_id")
      .eq("track_inventory", true)
      .not("reorder_level", "is", null);

    if (allError) throw allError;

    const lowStock = (allTracked || []).filter(
      (p) => p.stock_quantity !== null && p.reorder_level !== null && p.stock_quantity <= p.reorder_level
    );

    if (lowStock.length === 0) {
      console.log("[send-stock-alert-email] No low stock items found");
      return new Response(
        JSON.stringify({ success: true, message: "No low stock items", emailsSent: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group by organization
    const orgGroups: Record<string, typeof lowStock> = {};
    for (const product of lowStock) {
      if (!orgGroups[product.organization_id]) {
        orgGroups[product.organization_id] = [];
      }
      orgGroups[product.organization_id].push(product);
    }

    let totalEmailsSent = 0;

    for (const [orgId, products] of Object.entries(orgGroups)) {
      // Get org members with inventory management roles (admin/owner).
      // This project stores organization roles in user_roles, not organization_members.
      const { data: orgMembers, error: memberError } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .in("role", ["owner", "admin", "super_admin"]);

      if (memberError) {
        console.error(`[send-stock-alert-email] Failed to load recipients for org ${orgId}:`, memberError);
        continue;
      }

      if (!orgMembers || orgMembers.length === 0) continue;

      // Get org name
      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .single();

      const orgName = org?.name || "Your Organization";

      // Get user emails
      const userIds = orgMembers.map((m) => m.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, user_id, email, full_name")
        .in("user_id", userIds);

      if (!profiles || profiles.length === 0) continue;

      // Check email preferences — only send if inventory email is enabled
      const { data: prefs } = await supabase
        .from("notification_preferences")
        .select("user_id, email_enabled")
        .eq("organization_id", orgId)
        .eq("category", "inventory")
        .in("user_id", userIds);

      const prefsMap = (prefs || []).reduce((acc: Record<string, boolean>, p) => {
        acc[p.user_id] = p.email_enabled;
        return acc;
      }, {});

      // Build product rows HTML
      const productRows = products
        .map(
          (p) => `
          <tr>
            <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px;">${p.name}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: #6b7280;">${p.sku || "—"}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: ${(p.stock_quantity ?? 0) <= 0 ? "#dc2626" : "#f59e0b"}; font-weight: 600; text-align: right;">${p.stock_quantity ?? 0}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px; text-align: right;">${p.reorder_level}</td>
          </tr>
        `
        )
        .join("");

      const subject = `⚠️ Low Stock Alert — ${products.length} item${products.length > 1 ? "s" : ""} below reorder level`;

      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
          <div style="background: #f9fafb; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb;">
            <h2 style="margin: 0 0 8px; color: #111827; font-size: 20px;">⚠️ Low Stock Alert</h2>
            <p style="color: #6b7280; margin: 0 0 24px; font-size: 14px;">${orgName} — ${products.length} item${products.length > 1 ? "s need" : " needs"} attention</p>
            
            <div style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden;">
              <table style="width: 100%; border-collapse: collapse;">
                <thead>
                  <tr style="background: #f9fafb;">
                    <th style="padding: 10px 12px; text-align: left; font-size: 13px; color: #6b7280; font-weight: 600;">Product</th>
                    <th style="padding: 10px 12px; text-align: left; font-size: 13px; color: #6b7280; font-weight: 600;">SKU</th>
                    <th style="padding: 10px 12px; text-align: right; font-size: 13px; color: #6b7280; font-weight: 600;">Current Stock</th>
                    <th style="padding: 10px 12px; text-align: right; font-size: 13px; color: #6b7280; font-weight: 600;">Reorder Level</th>
                  </tr>
                </thead>
                <tbody>
                  ${productRows}
                </tbody>
              </table>
            </div>
            
            <p style="color: #6b7280; font-size: 13px; margin: 16px 0 0;">
              Please review inventory levels and create purchase orders as needed.
            </p>
            
            <p style="color: #9ca3af; font-size: 12px; margin: 24px 0 0; text-align: center;">
              Automated inventory alert from ${orgName}
            </p>
          </div>
        </div>
      `;

      // Send to each eligible admin/owner
      for (const profile of profiles) {
        // Check preference: default to enabled if no preference set
        const emailEnabled = prefsMap[profile.user_id] ?? true;
        if (!emailEnabled) {
          console.log(`[send-stock-alert-email] Email disabled for user ${profile.id}, skipping`);
          continue;
        }

        if (!profile.email) continue;

        try {
          await supabase.functions.invoke("send-email", {
            body: {
              to: profile.email,
              subject,
              html,
              category: "system_notification",
              organization_id: orgId,
              template_key: "inventory:low_stock_alert",
            },
          });
          totalEmailsSent++;
          console.log(`[send-stock-alert-email] Sent to ${profile.email}`);
        } catch (emailErr) {
          console.error(`[send-stock-alert-email] Failed to email ${profile.email}:`, emailErr);
        }
      }
    }

    console.log(`[send-stock-alert-email] Done. Total emails sent: ${totalEmailsSent}`);

    return new Response(
      JSON.stringify({
        success: true,
        lowStockItems: lowStock.length,
        emailsSent: totalEmailsSent,
        timestamp: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[send-stock-alert-email] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
