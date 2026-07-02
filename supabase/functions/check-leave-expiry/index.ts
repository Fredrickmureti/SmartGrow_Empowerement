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

    console.log("[check-leave-expiry] Running daily leave expiry check...");

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);

    const todayStr = today.toISOString().split("T")[0];
    const tomorrowStr = tomorrow.toISOString().split("T")[0];
    const dayAfterStr = dayAfterTomorrow.toISOString().split("T")[0];

    // Find approved leaves ending today, tomorrow, or day after
    const { data: expiringLeaves, error } = await supabase
      .from("leave_requests")
      .select(`
        *,
        employee:employees(id, first_name, last_name, work_email, email, user_id),
        leave_type:leave_types(id, name)
      `)
      .eq("status", "approved")
      .gte("end_date", todayStr)
      .lte("end_date", dayAfterStr);

    if (error) {
      console.error("[check-leave-expiry] Query error:", error);
      throw error;
    }

    console.log(`[check-leave-expiry] Found ${expiringLeaves?.length || 0} expiring leaves`);

    let emailsSent = 0;
    let notificationsCreated = 0;

    for (const leave of expiringLeaves || []) {
      const employee = leave.employee;
      if (!employee) continue;

      const endDate = leave.end_date;
      const leaveTypeName = leave.leave_type?.name || "Leave";
      const employeeName = `${employee.first_name} ${employee.last_name}`;
      const endDateFormatted = new Date(endDate).toLocaleDateString("en-US", { dateStyle: "long" });

      let reminderType = "";
      if (endDate === todayStr) {
        reminderType = "ends today";
      } else if (endDate === tomorrowStr) {
        reminderType = "ends tomorrow";
      } else {
        reminderType = "ends in 2 days";
      }

      const recipientEmail = employee.work_email || employee.email;

      // Send email reminder
      if (recipientEmail) {
        const subject = `🔔 Leave Reminder — Your ${leaveTypeName} ${reminderType}`;
        const html = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: #f9fafb; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb;">
              <h2 style="margin: 0 0 8px; color: #111827; font-size: 20px;">Leave Ending Reminder</h2>
              
              <div style="background: white; border-radius: 8px; padding: 24px; border: 1px solid #e5e7eb; margin: 24px 0;">
                <p style="color: #111827; font-size: 15px; margin: 0 0 16px;">
                  Hi ${employee.first_name}, this is a reminder that your <strong>${leaveTypeName}</strong> ${reminderType}.
                </p>
                
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">Leave Type</td>
                    <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${leaveTypeName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">End Date</td>
                    <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${endDateFormatted}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Days Taken</td>
                    <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;">${leave.days_requested}</td>
                  </tr>
                </table>
                
                <p style="color: #6b7280; font-size: 13px; margin: 16px 0 0;">
                  Please ensure a smooth return. If you need to extend your leave, contact your manager.
                </p>
              </div>
              
              <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
                Automated reminder from your HR system
              </p>
            </div>
          </div>
        `;

        try {
          await supabase.functions.invoke("send-email", {
            body: {
              to: recipientEmail,
              subject,
              html,
              category: "system_notification",
              organization_id: leave.organization_id,
              business_id: leave.business_id ?? null,
              template_key: "hr:leave_reminder",
            },
          });
          emailsSent++;
        } catch (emailErr) {
          console.error(`[check-leave-expiry] Failed to email ${recipientEmail}:`, emailErr);
        }
      }

      // Create in-app notification
      if (employee.user_id) {
        try {
          await supabase.from("notifications").insert({
            organization_id: leave.organization_id,
            business_id: leave.business_id,
            user_id: employee.user_id,
            type: "info",
            category: "leave",
            title: `Leave Reminder: ${leaveTypeName} ${reminderType}`,
            message: `Your ${leaveTypeName} (${leave.days_requested} days) ${reminderType} on ${endDateFormatted}.`,
            link: "/hr/my-portal",
            entity_type: "leave_request",
            entity_id: leave.id,
            priority: endDate === todayStr ? 1 : 0,
          });
          notificationsCreated++;
        } catch (notifErr) {
          console.error(`[check-leave-expiry] Failed to create notification:`, notifErr);
        }
      }
    }

    console.log(`[check-leave-expiry] Done. Emails: ${emailsSent}, Notifications: ${notificationsCreated}`);

    return new Response(
      JSON.stringify({
        success: true,
        expiringLeaves: expiringLeaves?.length || 0,
        emailsSent,
        notificationsCreated,
        timestamp: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[check-leave-expiry] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
