import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface SendLeaveEmailRequest {
  leaveRequestId: string;
  action: "approved" | "rejected" | "submitted" | "cancelled";
  rejectionReason?: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { leaveRequestId, action, rejectionReason }: SendLeaveEmailRequest = await req.json();

    if (!leaveRequestId || !action) {
      return new Response(
        JSON.stringify({ error: "Missing leaveRequestId or action" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch leave request with employee and leave type details
    const { data: leaveRequest, error: lrError } = await supabase
      .from("leave_requests")
      .select(`
        *,
        employee:employees(id, first_name, last_name, employee_number, work_email, email),
        leave_type:leave_types(id, name, code)
      `)
      .eq("id", leaveRequestId)
      .single();

    if (lrError || !leaveRequest) {
      console.error("[send-leave-email] Leave request not found:", lrError);
      return new Response(
        JSON.stringify({ error: "Leave request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Subscription active check ───
    if (leaveRequest.organization_id) {
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, leaveRequest.organization_id);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
    }

    const employee = leaveRequest.employee;
    if (!employee) {
      return new Response(
        JSON.stringify({ error: "Employee not found for leave request" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const recipientEmail = employee.work_email || employee.email;
    if (!recipientEmail) {
      console.warn("[send-leave-email] No email found for employee:", employee.id);
      return new Response(
        JSON.stringify({ error: "No email address for employee", skipped: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user has email enabled for 'leave' category
    const { data: empProfile } = await supabase
      .from("employees")
      .select("user_id")
      .eq("id", employee.id)
      .single();

    if (empProfile?.user_id) {
      const { data: pref } = await supabase
        .from("notification_preferences")
        .select("email_enabled")
        .eq("user_id", empProfile.user_id)
        .eq("organization_id", leaveRequest.organization_id)
        .eq("category", "leave")
        .maybeSingle();

      const emailEnabled = pref?.email_enabled ?? true;
      if (!emailEnabled) {
        console.log(`[send-leave-email] Email disabled for user=${empProfile.user_id}, skipping email`);
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "email_disabled" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Get organization name
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", leaveRequest.organization_id)
      .single();

    const orgName = org?.name || "Your Organization";
    const employeeName = `${employee.first_name} ${employee.last_name}`;
    const leaveTypeName = leaveRequest.leave_type?.name || "Leave";
    const startDate = new Date(leaveRequest.start_date).toLocaleDateString("en-US", { dateStyle: "long" });
    const endDate = new Date(leaveRequest.end_date).toLocaleDateString("en-US", { dateStyle: "long" });
    const days = leaveRequest.days_requested;

    // Build email based on action
    let subject = "";
    let statusColor = "";
    let statusLabel = "";
    let extraContent = "";

    switch (action) {
      case "approved":
        subject = `✅ Leave Request Approved — ${leaveTypeName}`;
        statusColor = "#16a34a";
        statusLabel = "Approved";
        extraContent = `<p>Your leave request has been approved. Enjoy your time off!</p>`;
        break;
      case "rejected":
        subject = `❌ Leave Request Rejected — ${leaveTypeName}`;
        statusColor = "#dc2626";
        statusLabel = "Rejected";
        extraContent = rejectionReason
          ? `<p>Your leave request has been rejected.</p><p><strong>Reason:</strong> ${rejectionReason}</p>`
          : `<p>Your leave request has been rejected. Please contact your manager for details.</p>`;
        break;
      case "submitted":
        subject = `📋 Leave Request Submitted — ${leaveTypeName}`;
        statusColor = "#f59e0b";
        statusLabel = "Pending Approval";
        extraContent = `<p>Your leave request has been submitted and is pending approval.</p>`;
        break;
      case "cancelled":
        subject = `🚫 Leave Request Cancelled — ${leaveTypeName}`;
        statusColor = "#6b7280";
        statusLabel = "Cancelled";
        extraContent = `<p>Your leave request has been cancelled.</p>`;
        break;
    }

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #f9fafb; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 8px; color: #111827; font-size: 20px;">Leave Request Update</h2>
          <p style="color: #6b7280; margin: 0 0 24px; font-size: 14px;">${orgName}</p>
          
          <div style="background: white; border-radius: 8px; padding: 24px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
              <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background: ${statusColor}20; color: ${statusColor}; font-weight: 600; font-size: 13px;">
                ${statusLabel}
              </span>
            </div>
            
            ${extraContent}
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">Employee</td>
                <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${employeeName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">Leave Type</td>
                <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${leaveTypeName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">From</td>
                <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${startDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-bottom: 1px solid #f3f4f6;">To</td>
                <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${endDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Days</td>
                <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: 500; text-align: right;">${days}</td>
              </tr>
            </table>
          </div>
          
          <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
            This is an automated notification from ${orgName}
          </p>
        </div>
      </div>
    `;

    // Send via the generic send-email function
    const { error: emailError } = await supabase.functions.invoke("send-email", {
      body: {
        to: recipientEmail,
        subject,
        html,
        category: "system_notification",
        organization_id: leaveRequest.organization_id,
        business_id: leaveRequest.business_id,
      },
    });

    if (emailError) {
      console.error("[send-leave-email] Failed to send email:", emailError);
      return new Response(
        JSON.stringify({ error: "Failed to send email", details: emailError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Also create an in-app notification for the employee
    // empProfile already fetched earlier for preference check

    if (empProfile?.user_id) {
      await supabase.from("notifications").insert({
        organization_id: leaveRequest.organization_id,
        business_id: leaveRequest.business_id,
        user_id: empProfile.user_id,
        type: action === "approved" ? "success" : action === "rejected" ? "error" : "info",
        category: "leave",
        title: subject.replace(/[✅❌📋🚫] /, ""),
        message: `Your ${leaveTypeName} request (${startDate} - ${endDate}) has been ${action}.`,
        link: "/hr/my-portal",
        entity_type: "leave_request",
        entity_id: leaveRequestId,
        priority: action === "rejected" ? 1 : 0,
      });
    }

    console.log(`[send-leave-email] Email sent for ${action} to ${recipientEmail}`);

    return new Response(
      JSON.stringify({ success: true, action, recipientEmail }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[send-leave-email] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
