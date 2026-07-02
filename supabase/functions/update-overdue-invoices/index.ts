import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
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

    const today = new Date().toISOString().split("T")[0];
    console.log(`[update-overdue-invoices] Starting overdue check for date: ${today}`);

    // Find all invoices that should be marked overdue
    const { data: overdueInvoices, error: fetchError } = await supabase
      .from("invoices")
      .select(`
        id,
        organization_id,
        invoice_number,
        contact_id,
        due_date,
        total,
        amount_paid,
        status
      `)
      .lt("due_date", today)
      .in("status", ["sent", "viewed", "partial"]);

    if (fetchError) {
      console.error("[update-overdue-invoices] Fetch error:", fetchError);
      throw fetchError;
    }

    console.log(`[update-overdue-invoices] Found ${overdueInvoices?.length || 0} invoices to mark as overdue`);

    const results: Array<{ id: string; invoiceNumber: string; status: string }> = [];

    // Per-iteration entitlement check: skip orgs whose subscription is not active.
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
    const entitlementCache = new Map<string, boolean>();

    for (const invoice of overdueInvoices || []) {
      try {
        // Subscription gate (cached per org)
        let allowed = entitlementCache.get(invoice.organization_id);
        if (allowed === undefined) {
          const r = await checkSubscriptionActive(supabase, invoice.organization_id);
          allowed = r.allowed;
          entitlementCache.set(invoice.organization_id, allowed);
        }
        if (!allowed) {
          console.log(`[update-overdue-invoices] Skipping ${invoice.id}: org subscription inactive`);
          continue;
        }

        // Update invoice status to overdue
        const { error: updateError } = await supabase
          .from("invoices")
          .update({ status: "overdue", updated_at: new Date().toISOString() })
          .eq("id", invoice.id);

        if (updateError) {
          console.error(`[update-overdue-invoices] Error updating invoice ${invoice.id}:`, updateError);
          continue;
        }

        // Create notification for the organization
        await supabase.from("notifications").insert({
          organization_id: invoice.organization_id,
          type: "invoice",
          title: "Invoice Overdue",
          message: `Invoice ${invoice.invoice_number} is now overdue. Balance: ${(invoice.total - (invoice.amount_paid || 0)).toFixed(2)}`,
          link: `/sales/invoices?id=${invoice.id}`,
          priority: "high",
          metadata: {
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            contact_id: invoice.contact_id,
            amount_due: invoice.total - (invoice.amount_paid || 0),
          },
        });

        // Log to audit
        await supabase.from("audit_logs").insert({
          organization_id: invoice.organization_id,
          entity_type: "invoice",
          entity_id: invoice.id,
          entity_name: invoice.invoice_number,
          action: "status_changed",
          changes_summary: `Invoice marked as overdue (was ${invoice.status})`,
          old_values: { status: invoice.status },
          new_values: { status: "overdue" },
        });

        // Fire-and-forget: SMS for invoice_overdue
        try {
          if (invoice.contact_id) {
            const { data: contact } = await supabase
              .from("contacts")
              .select("phone, name")
              .eq("id", invoice.contact_id)
              .maybeSingle();

            if (contact?.phone) {
              const smsUrl = `${supabaseUrl}/functions/v1/send-sms`;
              fetch(smsUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({
                  organization_id: invoice.organization_id,
                  event_type: "invoice_overdue",
                  recipient_phone: contact.phone,
                  template_variables: {
                    customer_name: contact.name || "",
                    invoice_number: invoice.invoice_number,
                    amount: String((invoice.total - (invoice.amount_paid || 0)).toFixed(2)),
                    due_date: invoice.due_date,
                  },
                }),
              }).catch((e) => console.error("[update-overdue-invoices] SMS error:", e));
            }
          }
        } catch (smsErr) {
          console.error("[update-overdue-invoices] SMS trigger error (non-blocking):", smsErr);
        }

        // Send email notification to org admins who have invoice email enabled
        try {
          const { data: orgMembers } = await supabase
            .from("organization_members")
            .select("user_id")
            .eq("organization_id", invoice.organization_id)
            .in("role", ["owner", "admin"]);

          if (orgMembers && orgMembers.length > 0) {
            const userIds = orgMembers.map((m) => m.user_id);
            const { data: prefs } = await supabase
              .from("notification_preferences")
              .select("user_id, email_enabled")
              .eq("organization_id", invoice.organization_id)
              .eq("category", "invoices")
              .in("user_id", userIds);

            const prefsMap = (prefs || []).reduce((acc: Record<string, boolean>, p) => {
              acc[p.user_id] = p.email_enabled;
              return acc;
            }, {});

            const { data: profiles } = await supabase
              .from("profiles")
              .select("id, email")
              .in("id", userIds);

            for (const profile of profiles || []) {
              const emailEnabled = prefsMap[profile.id] ?? true;
              if (!emailEnabled || !profile.email) continue;

              try {
                await supabase.functions.invoke("send-email", {
                  body: {
                    to: profile.email,
                    subject: `⚠️ Invoice ${invoice.invoice_number} is Overdue`,
                    html: `
                      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <div style="background: #f9fafb; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb;">
                          <h2 style="margin: 0 0 8px; color: #111827; font-size: 20px;">⚠️ Invoice Overdue</h2>
                          <div style="background: white; border-radius: 8px; padding: 24px; border: 1px solid #e5e7eb; border-left: 4px solid #dc2626; margin-top: 16px;">
                            <p style="color: #374151; font-size: 15px; margin: 0;">
                              Invoice <strong>${invoice.invoice_number}</strong> is now overdue.<br/>
                              Outstanding balance: <strong>$${(invoice.total - (invoice.amount_paid || 0)).toFixed(2)}</strong><br/>
                              Due date: ${invoice.due_date}
                            </p>
                          </div>
                          <p style="color: #9ca3af; font-size: 12px; margin: 24px 0 0; text-align: center;">
                            Manage notification preferences in Settings → Notifications
                          </p>
                        </div>
                      </div>
                    `,
                    category: "system_notification",
                    organization_id: invoice.organization_id,
                    business_id: invoice.business_id,
                  },
                });
                console.log(`[update-overdue-invoices] Overdue email sent to ${profile.email} for invoice ${invoice.invoice_number}`);
              } catch (emailErr) {
                console.error(`[update-overdue-invoices] Email error for ${profile.email}:`, emailErr);
              }
            }
          }
        } catch (emailDispatchErr) {
          console.error(`[update-overdue-invoices] Email dispatch error (non-blocking):`, emailDispatchErr);
        }

        console.log(`[update-overdue-invoices] Marked invoice ${invoice.invoice_number} as overdue`);
        results.push({ id: invoice.id, invoiceNumber: invoice.invoice_number, status: "updated" });
      } catch (error) {
        console.error(`[update-overdue-invoices] Error processing invoice ${invoice.id}:`, error);
      }
    }

    // ========== BILLS OVERDUE CHECK ==========
    console.log(`[update-overdue-invoices] Starting bills overdue check...`);
    
    const { data: overdueBills, error: billsFetchError } = await supabase
      .from("bills")
      .select(`id, organization_id, bill_number, vendor_id, due_date, total, amount_paid, status`)
      .lt("due_date", today)
      .in("status", ["received", "partial"]);

    if (billsFetchError) {
      console.error("[update-overdue-invoices] Bills fetch error:", billsFetchError);
    }

    console.log(`[update-overdue-invoices] Found ${overdueBills?.length || 0} bills to mark as overdue`);

    const billResults: Array<{ id: string; billNumber: string; status: string }> = [];

    for (const bill of overdueBills || []) {
      try {
        const { error: updateError } = await supabase
          .from("bills")
          .update({ status: "overdue", updated_at: new Date().toISOString() })
          .eq("id", bill.id);

        if (updateError) {
          console.error(`[update-overdue-invoices] Error updating bill ${bill.id}:`, updateError);
          continue;
        }

        // Create notification
        await supabase.from("notifications").insert({
          organization_id: bill.organization_id,
          type: "bill",
          title: "Bill Overdue",
          message: `Bill ${bill.bill_number} is now overdue. Balance: ${(bill.total - (bill.amount_paid || 0)).toFixed(2)}`,
          link: "/purchases/bills",
          priority: "high",
          metadata: {
            bill_id: bill.id,
            bill_number: bill.bill_number,
            vendor_id: bill.vendor_id,
            amount_due: bill.total - (bill.amount_paid || 0),
          },
        });

        // Audit log
        await supabase.from("audit_logs").insert({
          organization_id: bill.organization_id,
          entity_type: "bill",
          entity_id: bill.id,
          entity_name: bill.bill_number,
          action: "updated",
          changes_summary: `Bill marked as overdue (was ${bill.status})`,
          old_values: { status: bill.status },
          new_values: { status: "overdue" },
        });

        console.log(`[update-overdue-invoices] Marked bill ${bill.bill_number} as overdue`);
        billResults.push({ id: bill.id, billNumber: bill.bill_number, status: "updated" });
      } catch (error) {
        console.error(`[update-overdue-invoices] Error processing bill ${bill.id}:`, error);
      }
    }

    // Also call the database function for any edge cases
    const { data: dbUpdated, error: dbError } = await supabase.rpc("update_overdue_invoices");
    if (dbError) {
      console.warn("[update-overdue-invoices] DB function error (non-fatal):", dbError);
    } else {
      console.log(`[update-overdue-invoices] DB function updated ${dbUpdated} additional invoices`);
    }

    console.log(`[update-overdue-invoices] Completed. Updated ${results.length} invoices and ${billResults.length} bills`);

    return new Response(
      JSON.stringify({
        success: true,
        invoicesUpdated: results.length,
        billsUpdated: billResults.length,
        dbFunctionUpdated: dbUpdated || 0,
        results,
        billResults,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("[update-overdue-invoices] Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
