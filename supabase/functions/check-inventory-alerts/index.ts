import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");

    console.log("Running scheduled low stock check...");

    // Get all organizations that have active inventory
    const { data: orgs, error: orgError } = await supabase
      .from("products")
      .select("organization_id")
      .not("organization_id", "is", null);

    if (orgError) throw orgError;

    // Get unique org IDs
    const uniqueOrgIds = [...new Set((orgs || []).map((o: any) => o.organization_id))];
    
    let skippedOrgs = 0;
    let processedOrgs = 0;

    for (const orgId of uniqueOrgIds) {
      // ── Subscription check: skip if org subscription is not active ──
      const subCheck = await checkSubscriptionActive(supabase, orgId as string);
      if (!subCheck.allowed) {
        console.log(`[check-inventory-alerts] Skipping org ${orgId}: ${subCheck.reason}`);
        await supabase.from("platform_admin_alerts").insert({
          alert_type: "background_job_skipped",
          severity: "warning",
          title: `Inventory alerts skipped for org`,
          details: { function: "check-inventory-alerts", reason: subCheck.reason },
          organization_id: orgId,
        });
        skippedOrgs++;
        continue;
      }
      processedOrgs++;
    }

    // Call the database function that checks all products (for active orgs)
    const { error } = await supabase.rpc("check_low_stock_products");

    if (error) {
      console.error("Error running low stock check:", error);
      throw error;
    }

    console.log("Low stock check completed successfully");

    // Run auto-replenishment engine
    console.log("Running auto-replenishment check...");
    const { data: replenishmentResult, error: replenishmentError } = await supabase.rpc("auto_create_replenishment_po");

    if (replenishmentError) {
      console.error("Error running auto-replenishment:", replenishmentError);
    } else {
      console.log("Auto-replenishment completed:", replenishmentResult);
    }

    // Send email alerts to management for low stock items
    console.log("Sending stock alert emails to management...");
    try {
      await supabase.functions.invoke("send-stock-alert-email");
      console.log("Stock alert emails dispatched");
    } catch (emailErr) {
      console.error("Failed to send stock alert emails:", emailErr);
    }

    // SMS alerts: enqueue ONE outbox row per org with low-stock items.
    // Per-org thresholds come from `notification_alert_settings` (warning level).
    // If no row exists, fall back to the documented default (warning=10).
    try {
      const { data: settingsRows } = await supabase
        .from("notification_alert_settings")
        .select("organization_id, low_stock_warning_threshold, low_stock_critical_threshold, out_of_stock_alert")
        .is("business_id", null); // org-default rows

      const thresholdsByOrg = new Map<
        string,
        { warning: number; critical: number; outOfStock: boolean }
      >();
      for (const row of (settingsRows || []) as Array<{
        organization_id: string;
        low_stock_warning_threshold: number | null;
        low_stock_critical_threshold: number | null;
        out_of_stock_alert: boolean | null;
      }>) {
        thresholdsByOrg.set(row.organization_id, {
          warning: row.low_stock_warning_threshold ?? 10,
          critical: row.low_stock_critical_threshold ?? 5,
          outOfStock: row.out_of_stock_alert ?? true,
        });
      }

      // Pull all tracked products with reorder enabled, then filter per-org by
      // that org's configured warning threshold.
      const { data: trackedProducts } = await supabase
        .from("products")
        .select("organization_id, name, stock_quantity")
        .gt("reorder_level", 0);

      const byOrg = new Map<string, string[]>();
      for (const p of (trackedProducts || []) as Array<{
        organization_id: string;
        name: string;
        stock_quantity: number | null;
      }>) {
        const t = thresholdsByOrg.get(p.organization_id) ?? {
          warning: 10,
          critical: 5,
          outOfStock: true,
        };
        const qty = p.stock_quantity ?? 0;
        if (qty <= t.warning) {
          if (!byOrg.has(p.organization_id)) byOrg.set(p.organization_id, []);
          byOrg.get(p.organization_id)!.push(p.name);
        }
      }

      // Look up org/business display names so templates with {{company_name}}
      // and {{branch_name}} render properly.
      const orgIds = [...byOrg.keys()];
      const orgNames = new Map<string, string>();
      if (orgIds.length > 0) {
        const { data: orgRows } = await supabase
          .from("organizations").select("id, name").in("id", orgIds);
        for (const o of (orgRows || []) as Array<{ id: string; name: string | null }>) {
          orgNames.set(o.id, o.name ?? "");
        }
      }

      for (const [orgId, productNames] of byOrg.entries()) {
        const sample = productNames.slice(0, 3).join(", ");
        const { error: enqErr } = await supabase.from("sms_event_outbox").insert({
          organization_id: orgId,
          event_type: "low_stock_alert",
          entity_type: "product_batch",
          entity_id: null,
          recipient_phone: null,            // resolver will fan out
          recipient_contact_id: null,
          template_variables: {
            count: String(productNames.length),
            sample_products: sample,
            company_name: orgNames.get(orgId) ?? "",
            branch_name: "",
            severity: "warning",
          },
        });
        if (enqErr) {
          // Fall back to a no-op log; rule may simply be disabled (insert ok then) or RLS-blocked.
          console.error(`[check-inventory-alerts] outbox insert failed for org ${orgId}:`, enqErr.message);
        }
      }
    } catch (smsErr) {
      console.error("Failed to enqueue low-stock SMS:", smsErr);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Low stock check, auto-replenishment, and email alerts completed",
        replenishment: replenishmentResult || null,
        processedOrgs,
        skippedOrgs,
        timestamp: new Date().toISOString()
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("Error in check-inventory-alerts:", errorMessage);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: errorMessage 
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500 
      }
    );
  }
});
