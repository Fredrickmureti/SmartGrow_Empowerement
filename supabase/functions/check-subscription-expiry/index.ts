import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Grace period in days before marking subscriptions as expired
const GRACE_PERIOD_DAYS = 3;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Apply grace period: only expire subscriptions that ended more than GRACE_PERIOD_DAYS ago
    const graceDate = new Date();
    graceDate.setDate(graceDate.getDate() - GRACE_PERIOD_DAYS);
    const graceDateISO = graceDate.toISOString();
    const now = new Date().toISOString();

    let expiredTrials = 0;
    let expiredSubscriptions = 0;
    let appTrialsExpired = 0;
    let appTrialsConverted = 0;
    let trialNotificationsSent = 0;

    // Find and expire trial organizations (trials use exact expiry, no grace period)
    const { data: trialOrgs, error: trialError } = await supabase
      .from("organizations")
      .select("id, name, trial_ends_at")
      .eq("subscription_status", "trial")
      .not("trial_ends_at", "is", null)
      .lt("trial_ends_at", now);

    if (trialError) {
      console.error("Error fetching trial orgs:", trialError);
    } else if (trialOrgs && trialOrgs.length > 0) {
      const orgIds = trialOrgs.map(org => org.id);
      
      const { error: updateTrialError } = await supabase
        .from("organizations")
        .update({ 
          subscription_status: "expired",
          updated_at: now 
        })
        .in("id", orgIds);

      if (updateTrialError) {
        console.error("Error updating trial orgs:", updateTrialError);
      } else {
        expiredTrials = trialOrgs.length;
        console.log(`Expired ${expiredTrials} trial subscriptions:`, trialOrgs.map(o => o.name));
      }
    }

    // Find and expire active subscriptions (with grace period)
    const { data: activeOrgs, error: activeError } = await supabase
      .from("organizations")
      .select("id, name, subscription_ends_at")
      .eq("subscription_status", "active")
      .not("subscription_ends_at", "is", null)
      .lt("subscription_ends_at", graceDateISO);

    if (activeError) {
      console.error("Error fetching active orgs:", activeError);
    } else if (activeOrgs && activeOrgs.length > 0) {
      const orgIds = activeOrgs.map(org => org.id);
      
      const { error: updateActiveError } = await supabase
        .from("organizations")
        .update({ 
          subscription_status: "expired",
          updated_at: now 
        })
        .in("id", orgIds);

      if (updateActiveError) {
        console.error("Error updating active orgs:", updateActiveError);
      } else {
        expiredSubscriptions = activeOrgs.length;
        console.log(`Expired ${expiredSubscriptions} active subscriptions:`, activeOrgs.map(o => o.name));
      }
    }

    // ------------------------------------------------------------------
    // Per-app trial lifecycle (Odoo-style add-on trials)
    // ------------------------------------------------------------------
    // 1) Auto-convert active trials whose plan now grants the app.
    try {
      const { data: convertedCount, error: convertError } = await supabase.rpc(
        "convert_app_trials_on_plan_change",
        { p_org_id: null },
      );
      if (convertError) console.error("convert_app_trials_on_plan_change error:", convertError);
      else appTrialsConverted = Number(convertedCount ?? 0);
    } catch (e) {
      console.error("convert_app_trials_on_plan_change threw:", e);
    }

    // 2) Notify at T-3 / T-1 / T-0 and mark expired trials.
    const nowMs = Date.now();
    const { data: activeAppTrials, error: appTrialErr } = await supabase
      .from("app_trial_status")
      .select("id, organization_id, app_id, expires_at, status")
      .eq("status", "active")
      .not("expires_at", "is", null);

    if (appTrialErr) {
      console.error("Error fetching app trials:", appTrialErr);
    } else if (activeAppTrials && activeAppTrials.length > 0) {
      for (const trial of activeAppTrials) {
        const expMs = new Date(trial.expires_at as string).getTime();
        const daysLeft = Math.ceil((expMs - nowMs) / 86_400_000);

        // Notify at T-3, T-1, T-0 (the SQL function dedups within 24h).
        if ([3, 1, 0].includes(daysLeft) || daysLeft < 0) {
          const notifyDays = Math.max(0, daysLeft);
          const { error: notifyErr } = await supabase.rpc("notify_app_trial_expiring", {
            p_org_id: trial.organization_id,
            p_app_id: trial.app_id,
            p_days_left: notifyDays,
          });
          if (notifyErr) console.error("notify_app_trial_expiring error:", notifyErr);
          else trialNotificationsSent++;
        }

        // Mark expired once past expiry.
        if (expMs <= nowMs) {
          const { error: expErr } = await supabase
            .from("app_trial_status")
            .update({ status: "expired", updated_at: now })
            .eq("id", trial.id);
          if (expErr) console.error("Error expiring app trial:", expErr);
          else appTrialsExpired++;
        }
      }
    }

    // 3) Final sweep: enforce Odoo-style trial expiry.
    //    Marks any still-active trials past expiry as 'expired' AND deactivates
    //    the corresponding installed_apps row when no other entitlement exists
    //    (no plan coverage, no override). Belt-and-braces with the per-trial
    //    loop above; idempotent.
    let appTrialsDisabled = 0;
    try {
      const { data: sweep, error: sweepErr } = await supabase.rpc(
        "disable_expired_app_trials",
      );
      if (sweepErr) {
        console.error("disable_expired_app_trials error:", sweepErr);
      } else if (Array.isArray(sweep) && sweep.length > 0) {
        const row = sweep[0] as { expired_count?: number; disabled_count?: number };
        // The per-trial loop above already counted expirations; only add deltas.
        appTrialsExpired = Math.max(appTrialsExpired, Number(row.expired_count ?? 0));
        appTrialsDisabled = Number(row.disabled_count ?? 0);
      }
    } catch (e) {
      console.error("disable_expired_app_trials threw:", e);
    }

    // Log the results
    const summary = {
      timestamp: now,
      grace_period_days: GRACE_PERIOD_DAYS,
      expired_trials: expiredTrials,
      expired_subscriptions: expiredSubscriptions,
      app_trials_expired: appTrialsExpired,
      app_trials_converted: appTrialsConverted,
      app_trials_disabled: appTrialsDisabled,
      trial_notifications_sent: trialNotificationsSent,
      total_expired: expiredTrials + expiredSubscriptions,
    };

    console.log("Subscription expiry check completed:", summary);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Subscription expiry check completed",
        ...summary,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error: unknown) {
    console.error("Error in subscription expiry check:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
