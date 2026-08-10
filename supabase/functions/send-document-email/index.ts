import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { resolvePrintPolicy } from "../_shared/printing/resolvePolicy.ts";
import { resolveCanonicalPdf } from "../_shared/documents/canonicalPdf.ts";
import { formatAccountingNumber as formatCurrency } from "../_shared/format/index.ts";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type EmailDocumentType = "invoice" | "estimate" | "proforma" | "credit_note" | "delivery_note" | "purchase_order" | "bill" | "customer_statement" | "receipt" | "sales_return" | "sales_order" | "report" | "payslip" | "pos_receipt" | "contract_letter";

interface SendDocumentEmailRequest {
  documentType: EmailDocumentType;
  documentId: string;
  recipientEmail?: string;
  /**
   * Bulk-mode flag: when true and `recipientEmail` is omitted, the server
   * resolves the recipient from the document's contact (or the employee
   * record for payslips). This lets the unified SendDocumentDialog fan
   * out one call per id without the client having to pre-hydrate emails.
   */
  resolveRecipientFromRow?: boolean;
  ccEmails?: string[];
  bccEmails?: string[];
  subject?: string;
  message?: string;
  autoGeneratePdf?: boolean;
  attachPdf?: boolean;
  pdfBase64?: string;
  pdfFilename?: string;
  // ── "report" documentType only ──
  // Reports are not stored as a database row — the caller passes the rendered
  // PDF and identifying metadata directly. organization_id is required so
  // the audit log row in `document_emails` is correctly tenant-scoped.
  organizationId?: string;
  businessId?: string;
  reportTitle?: string;
  reportSubtype?: string; // e.g. "vendor_statement", "aged_payables", "trial_balance"
  reportPeriod?: string;
}

interface PlatformSetting {
  setting_key: string;
  setting_value: string | null;
}

const documentTableMap: Record<EmailDocumentType, { table: string; numberField: string; statusField?: string; itemsTable?: string; contactField?: string }> = {
  invoice: { table: "invoices", numberField: "invoice_number", statusField: "status", itemsTable: "invoice_items" },
  estimate: { table: "estimates", numberField: "estimate_number", statusField: "status", itemsTable: "estimate_items" },
  proforma: { table: "proforma_invoices", numberField: "proforma_number", statusField: "status", itemsTable: "proforma_invoice_items" },
  credit_note: { table: "credit_notes", numberField: "credit_note_number", statusField: "status", itemsTable: "credit_note_items" },
  delivery_note: { table: "delivery_notes", numberField: "delivery_number", statusField: "status", itemsTable: "delivery_note_items" },
  purchase_order: { table: "purchase_orders", numberField: "po_number", statusField: "status", itemsTable: "purchase_order_items", contactField: "vendor_id" },
  bill: { table: "bills", numberField: "bill_number", statusField: "status", itemsTable: "bill_items", contactField: "vendor_id" },
  customer_statement: { table: "customer_statements", numberField: "id", statusField: undefined, itemsTable: undefined, contactField: "contact_id" },
  receipt: { table: "customer_payments", numberField: "receipt_number", statusField: undefined, itemsTable: undefined },
  sales_return: { table: "sales_returns", numberField: "return_number", statusField: "status", itemsTable: "sales_return_items" },
  sales_order: { table: "sales_orders", numberField: "order_number", statusField: "status", itemsTable: "sales_order_items" },
  // Payroll — number is synthesized from payroll_runs.payroll_number; recipient is the employee's work_email/email.
  payslip: { table: "payslips", numberField: "payslip_number", statusField: "status", itemsTable: undefined, contactField: "employee_id" },
  // POS receipt — A4 invoice-style receipt, generated via the unified generate-document engine (already supports pos_receipt).
  // HR letters — employment contract. Recipient is the employee (work_email
  // first). `statusField` is deliberately omitted: contract status is a
  // lifecycle value (new/running/expired/cancelled), never "sent".
  contract_letter: { table: "employee_contracts", numberField: "contract_reference", statusField: undefined, itemsTable: undefined, contactField: "employee_id" },
  pos_receipt: { table: "pos_transactions", numberField: "transaction_number", statusField: undefined, itemsTable: undefined, contactField: "customer_id" },
};

const documentLabels: Record<EmailDocumentType, string> = {
  invoice: "Invoice",
  estimate: "Estimate",
  proforma: "Proforma Invoice",
  credit_note: "Credit Note",
  delivery_note: "Delivery Note",
  purchase_order: "Purchase Order",
  bill: "Bill",
  customer_statement: "Customer Statement",
  receipt: "Payment Receipt",
  sales_return: "Sales Return",
  sales_order: "Sales Order",
  report: "Report",
  payslip: "Payslip",
  pos_receipt: "Sales Receipt",
  contract_letter: "Employment Contract",
};

async function getPlatformSettings(supabaseClient: any): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseClient
    .from("platform_settings")
    .select("setting_key, setting_value");

  if (error) {
    console.error("Error fetching platform settings:", error);
    throw new Error("Failed to fetch email configuration");
  }

  const settings = new Map<string, string | null>();
  (data as PlatformSetting[]).forEach((s) => {
    settings.set(s.setting_key, s.setting_value);
  });
  return settings;
}

function generateEmailHtml(
  document: any,
  documentType: EmailDocumentType,
  message: string | undefined,
  branding: any
): string {
  const docLabel = documentLabels[documentType];
  const docNumber = document[documentTableMap[documentType].numberField];
  const orgName = branding?.legal_name || branding?.name || "Our Company";
  
  let totalAmount = document.total;
  let currency =
    document.currency ||
    document.business?.base_currency ||
    branding?.base_currency ||
    "USD";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${docLabel} ${docNumber}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div style="background: #1a1a2e; color: white; padding: 24px; text-align: center;">
          ${branding?.logo_url ? `<img src="${branding.logo_url}" alt="${orgName}" style="max-height: 60px; margin-bottom: 12px;">` : ""}
          <h1 style="margin: 0; font-size: 24px;">${orgName}</h1>
        </div>
        
        <div style="padding: 24px;">
          <h2 style="margin: 0 0 16px; color: #333;">${docLabel} ${docNumber}</h2>
          
          ${message ? `<div style="color: #666; line-height: 1.6; white-space: pre-wrap; margin-bottom: 20px;">${message}</div>` : ""}
          
          <div style="background: #f9f9f9; border-radius: 6px; padding: 16px; margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666;">${docLabel} Number:</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${docNumber}</td>
              </tr>
              ${document.issue_date ? `
              <tr>
                <td style="padding: 8px 0; color: #666;">Issue Date:</td>
                <td style="padding: 8px 0; text-align: right;">${new Date(document.issue_date).toLocaleDateString()}</td>
              </tr>
              ` : ""}
              ${document.due_date ? `
              <tr>
                <td style="padding: 8px 0; color: #666;">Due Date:</td>
                <td style="padding: 8px 0; text-align: right;">${new Date(document.due_date).toLocaleDateString()}</td>
              </tr>
              ` : ""}
              ${totalAmount !== undefined ? `
              <tr style="border-top: 2px solid #e0e0e0;">
                <td style="padding: 16px 0 8px; color: #333; font-weight: 600; font-size: 18px;">Total Amount:</td>
                <td style="padding: 16px 0 8px; text-align: right; font-weight: 600; font-size: 18px; color: #1a1a2e;">
                  ${formatCurrency(totalAmount, currency)}
                </td>
              </tr>
              ` : ""}
            </table>
          </div>
          
          ${documentType === "invoice" && document.payment_link ? `
            <div style="text-align: center; margin: 24px 0;">
              <a href="${document.payment_link}" style="display: inline-block; background: #1a1a2e; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Pay Now
              </a>
            </div>
          ` : ""}
          
          <p style="color: #666; font-size: 14px; margin-top: 24px;">
            If you have any questions about this ${docLabel.toLowerCase()}, please contact us.
          </p>
        </div>
        
        <div style="background: #f9f9f9; padding: 16px 24px; text-align: center; color: #999; font-size: 12px;">
          <p style="margin: 0;">This email was sent by ${orgName}</p>
          ${branding?.email ? `<p style="margin: 4px 0 0;">Contact: ${branding.email}</p>` : ""}
        </div>
      </div>
    </body>
    </html>
  `;
}

async function sendWithResend(
  apiKey: string,
  fromEmail: string,
  fromName: string,
  to: string,
  cc: string[] | undefined,
  bcc: string[] | undefined,
  subject: string,
  html: string,
  replyTo: string | undefined,
  attachments?: Array<{ filename: string; content: string }>
) {
  const resend = new Resend(apiKey);

  const emailOptions: any = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject,
    html,
  };

  if (cc && cc.length > 0) emailOptions.cc = cc;
  if (bcc && bcc.length > 0) emailOptions.bcc = bcc;
  if (replyTo) emailOptions.reply_to = replyTo;
  
  if (attachments && attachments.length > 0) {
    emailOptions.attachments = attachments.map(att => ({
      filename: att.filename,
      content: att.content,
    }));
  }

  return await resend.emails.send(emailOptions);
}

async function sendWithSendGrid(
  apiKey: string,
  fromEmail: string,
  fromName: string,
  to: string,
  cc: string[] | undefined,
  bcc: string[] | undefined,
  subject: string,
  html: string,
  replyTo: string | undefined,
  attachments?: Array<{ filename: string; content: string }>
) {
  const personalizations: any = { to: [{ email: to }] };
  if (cc && cc.length > 0) personalizations.cc = cc.map((e) => ({ email: e }));
  if (bcc && bcc.length > 0) personalizations.bcc = bcc.map((e) => ({ email: e }));

  const payload: any = {
    personalizations: [personalizations],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [{ type: "text/html", value: html }],
  };

  if (replyTo) payload.reply_to = { email: replyTo };
  
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.map(att => ({
      content: att.content,
      filename: att.filename,
      type: "application/pdf",
      disposition: "attachment",
    }));
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendGrid error: ${error}`);
  }

  return { id: "sendgrid-sent" };
}

async function sendWithMailgun(
  apiKey: string,
  domain: string,
  fromEmail: string,
  fromName: string,
  to: string,
  cc: string[] | undefined,
  bcc: string[] | undefined,
  subject: string,
  html: string,
  replyTo: string | undefined,
  attachments?: Array<{ filename: string; content: string }>
) {
  const formData = new FormData();
  formData.append("from", `${fromName} <${fromEmail}>`);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("html", html);
  
  if (cc && cc.length > 0) formData.append("cc", cc.join(","));
  if (bcc && bcc.length > 0) formData.append("bcc", bcc.join(","));
  if (replyTo) formData.append("h:Reply-To", replyTo);
  
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const binaryString = atob(att.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/pdf" });
      formData.append("attachment", blob, att.filename);
    }
  }

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mailgun error: ${error}`);
  }

  return await response.json();
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Failure audit context. `document_emails` is the single communication
  // ledger, so a send that throws must leave a row behind — a success-only
  // trail makes "we never emailed this customer" indistinguishable from
  // "the provider rejected it".
  let failureAudit:
    | {
        client: any;
        organization_id: string;
        business_id?: string | null;
        document_type: string;
        document_id: string;
        recipient_email: string;
        subject: string | null;
        sent_by: string | null;
      }
    | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }
    const userJwt = authHeader.replace(/^Bearer\s+/i, "");

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      throw new Error("Unauthorized");
    }

    const body: SendDocumentEmailRequest = await req.json();
    const {
      documentType,
      documentId,
      recipientEmail: rawRecipientEmail,
      resolveRecipientFromRow,
      ccEmails,
      bccEmails,
      subject,
      message,
      autoGeneratePdf,
      attachPdf,
      pdfBase64,
      pdfFilename,
    } = body;
    let recipientEmail = rawRecipientEmail;

    if (!documentType) {
      throw new Error("Missing required field: documentType");
    }
    if (!recipientEmail && !resolveRecipientFromRow && documentType !== "report") {
      throw new Error("Missing required field: recipientEmail (or set resolveRecipientFromRow=true for bulk sends)");
    }
    if (documentType !== "report" && !documentId) {
      throw new Error("Missing required field: documentId");
    }

    // ─── Generic report email path ───────────────────────────────────
    // Reports are not persisted as a document row. The caller (typically
    // ReportExportButtons → EmailReportDialog) renders the PDF client-side
    // via the same `render-report` pipeline used by Download-as-PDF, then
    // hands us the bytes. We reuse the platform email provider, branding
    // resolution, and audit log so reports look and trace identically to
    // every other outbound document.
    if (documentType === "report") {
      const {
        organizationId,
        businessId,
        reportTitle,
        reportSubtype,
        reportPeriod,
      } = body;

      if (!organizationId) {
        throw new Error("organizationId is required for report emails");
      }
      if (!pdfBase64) {
        throw new Error("pdfBase64 is required for report emails");
      }

      // Authorization via RLS: the user-scoped client can only see
      // organizations the caller belongs to. If maybeSingle() returns null
      // here, the caller is not a member and we refuse the send.
      const { data: orgRow, error: orgErr } = await userClient
        .from("organizations")
        .select("id")
        .eq("id", organizationId)
        .maybeSingle();
      if (orgErr || !orgRow) {
        throw new Error("Forbidden: user is not a member of this organization");
      }

      // Subscription gate (same as document path).
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import(
        "../_shared/entitlementCheck.ts"
      );
      const subResult = await checkSubscriptionActive(supabaseClient, organizationId);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);

      // Resolve sender identity via the shared resolver (ADR 0023) so the
      // report-email path uses the same email_display_name → legal_name →
      // name → org_name → platform tier as every other tenant-facing
      // surface. Only the multi-provider transport stays here.
      const settings = await getPlatformSettings(supabaseClient);
      const emailProvider = settings.get("email_provider") || "resend";
      const { resolveSenderIdentity } = await import(
        "../_shared/branding/resolveSenderIdentity.ts"
      );
      const identity = await resolveSenderIdentity(supabaseClient, {
        category: "tenant_document",
        organization_id: organizationId,
        business_id: businessId ?? null,
      });
      const platformFromEmail = identity.from_email;
      const effectiveFromName = identity.from_name;
      const effectiveReplyTo = identity.reply_to ?? undefined;
      console.log(
        `[send-document-email] report path sender_source=${identity.source} from="${effectiveFromName}"`,
      );

      let apiKey: string | null = null;
      switch (emailProvider) {
        case "resend": apiKey = settings.get("resend_api_key") ?? null; break;
        case "sendgrid": apiKey = settings.get("sendgrid_api_key") ?? null; break;
        case "mailgun": apiKey = settings.get("mailgun_api_key") ?? null; break;
      }
      if (!apiKey) {
        throw new Error(`Email provider (${emailProvider}) is not configured. Please configure it in Admin Settings.`);
      }

      const safeTitle = (reportTitle || "Report").trim();
      const periodLabel = reportPeriod ? ` — ${reportPeriod}` : "";
      // `resolveSenderIdentity` (ADR 0023) already applied the
      // display-name → legal_name → name → org ladder above; the old
      // `businessRow` local it used to read no longer exists on this path.
      const senderIdentity = effectiveFromName || "Your Provider";
      const emailSubject = subject || `${safeTitle}${periodLabel}`;
      const filename = pdfFilename || `${safeTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

      const userMessage = (message || "").trim();
      const messageHtml = userMessage
        ? `<p style="white-space:pre-wrap;margin:0 0 16px 0;">${userMessage
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/\n/g, "<br/>")}</p>`
        : "";

      const emailHtml = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;max-width:640px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px 0;font-size:18px;">${safeTitle}${periodLabel}</h2>
        ${messageHtml}
        <p style="margin:0 0 8px 0;">Please find the report attached as a PDF.</p>
        <p style="margin:24px 0 0 0;color:#666;font-size:12px;">Sent by ${senderIdentity}</p>
      </body></html>`;

      const attachments = [{ filename, content: pdfBase64 }];

      let result;
      switch (emailProvider) {
        case "resend":
          result = await sendWithResend(apiKey, platformFromEmail, effectiveFromName, recipientEmail, ccEmails, bccEmails, emailSubject, emailHtml, effectiveReplyTo, attachments);
          break;
        case "sendgrid":
          result = await sendWithSendGrid(apiKey, platformFromEmail, effectiveFromName, recipientEmail, ccEmails, bccEmails, emailSubject, emailHtml, effectiveReplyTo, attachments);
          break;
        case "mailgun": {
          const mailgunDomain = settings.get("mailgun_domain");
          if (!mailgunDomain) throw new Error("Mailgun domain not configured");
          result = await sendWithMailgun(apiKey, mailgunDomain, platformFromEmail, effectiveFromName, recipientEmail, ccEmails, bccEmails, emailSubject, emailHtml, effectiveReplyTo, attachments);
          break;
        }
        default: throw new Error(`Unknown email provider: ${emailProvider}`);
      }

      // Synthesize a stable id for the audit row so multiple sends of the
      // same report (e.g. resend after a typo) are independently traceable.
      const reportAuditId = crypto.randomUUID();
      // Encode subtype + period in the message column (text) for now; if a
      // dedicated `metadata jsonb` column is added later this should move.
      const metadataNote = [
        reportSubtype ? `[subtype:${reportSubtype}]` : null,
        reportPeriod ? `[period:${reportPeriod}]` : null,
        userMessage || null,
      ].filter(Boolean).join("\n");

      await supabaseClient.from("document_emails").insert({
        organization_id: organizationId,
        business_id: businessId ?? null,
        document_type: "report",
        document_id: reportAuditId,
        recipient_email: recipientEmail,
        cc_emails: ccEmails && ccEmails.length > 0 ? ccEmails : null,
        bcc_emails: bccEmails && bccEmails.length > 0 ? bccEmails : null,
        subject: emailSubject,
        message: metadataNote || null,
        status: "sent",
        had_attachment: true,
        attachment_filename: filename,
        sent_by: user.id,
        pdf_generated_at: new Date().toISOString(),
        pdf_file_size_bytes: Math.floor((pdfBase64.length * 3) / 4),
      });

      console.log("Report email sent:", { reportSubtype, recipientEmail, result });
      return new Response(
        JSON.stringify({ success: true, message: "Report email sent successfully", reportAuditId }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const tableConfig = documentTableMap[documentType];
    if (!tableConfig) {
      throw new Error(`Invalid document type: ${documentType}`);
    }

    // Fetch document with workspace, company (business), and contact.
    // Email identity (display_name, reply_to, contact email) lives on `businesses`.
    const businessJoin = `business:businesses!${tableConfig.table}_business_id_fkey(id, name, legal_name, logo_url, email, email_display_name, email_reply_to, base_currency)`;
    let selectQuery = `*, organization:organizations(id, name), ${businessJoin}`;
    if (documentType === "purchase_order") {
      selectQuery = `*, contact:contacts!purchase_orders_vendor_id_fkey(*), organization:organizations(id, name), ${businessJoin}`;
    } else if (documentType === "bill") {
      selectQuery = `*, contact:contacts!bills_vendor_id_fkey(*), organization:organizations(id, name), ${businessJoin}`;
    } else if (documentType === "customer_statement") {
      selectQuery = `*, contact:contacts!customer_statements_contact_id_fkey(*), organization:organizations(id, name), ${businessJoin}`;
  } else if (documentType === "payslip") {
    // Payslip recipient is the employee — there is no `contacts` row. We
    // alias the employee join as `contact` so the rest of the pipeline
    // (recipient resolution, branding, etc.) works unchanged.
    selectQuery = `*, contact:employees!payslips_employee_id_fkey(id, first_name, last_name, work_email, email, employee_number), payroll_run:payroll_runs(id, payroll_number, pay_period_start, pay_period_end), organization:organizations(id, name), ${businessJoin}`;
  } else if (documentType === "contract_letter") {
    // Same shape as payslips: the recipient is an employee, not a contact.
    selectQuery = `*, contact:employees!employee_contracts_employee_id_fkey(id, first_name, last_name, work_email, email, employee_number), organization:organizations(id, name), ${businessJoin}`;
  } else if (documentType === "pos_receipt") {
    selectQuery = `*, contact:contacts!pos_transactions_customer_id_fkey(*), organization:organizations(id, name), ${businessJoin}`;
    } else {
      selectQuery = `*, contact:contacts(*), organization:organizations(id, name), ${businessJoin}`;
    }
    
    let resolvedDocumentId = documentId;

    let documentQuery = supabaseClient
      .from(tableConfig.table)
      .select(selectQuery)
      .eq("id", resolvedDocumentId)
      .maybeSingle();

    const { data: documentRaw, error: docError } = await documentQuery;

    // RETIRED: the "statement not found by id → email the customer's most
    // recent statement instead" fallback. Every caller passes a persisted
    // statement id (CustomerStatements.tsx saves before sending), and guessing
    // silently emailed a DIFFERENT period to the customer. Not found is now
    // a 404, as it is for every other document type.


    const document = documentRaw as any;

    if (docError || !document) {
      console.warn("Document not found", { documentType, documentId, resolvedDocumentId, docError: docError?.message });
      return new Response(
        JSON.stringify({
          success: false,
          error: `${documentLabels[documentType]} not found`,
          error_code: "DOCUMENT_NOT_FOUND",
          documentType,
          documentId,
        }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ─── Tenant isolation: caller must be an active member of the doc's org ───
    if (!document.organization_id) {
      return new Response(
        JSON.stringify({ success: false, error: "Document missing organization", error_code: "FORBIDDEN" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    {
      const { data: membership } = await userClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("organization_id", document.organization_id)
        .eq("is_active", true)
        .maybeSingle();
      if (!membership) {
        return new Response(
          JSON.stringify({ success: false, error: "Forbidden", error_code: "FORBIDDEN" }),
          { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // ─── Subscription active check ───
    {
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabaseClient, document.organization_id);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
    }

    // ─── Bulk-mode: resolve recipient from document contact ──────────
    // For payslips, contact is aliased to the employee row; pick work_email
    // first (HR/payroll convention), then personal email. For everything
    // else, fall through to contacts.email.
    if (!recipientEmail) {
      const contact = document.contact;
      const resolved =
        documentType === "payslip" || documentType === "contract_letter"
          ? (contact?.work_email || contact?.email)
          : (contact?.email);
      if (!resolved) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `No recipient email on file for this ${documentLabels[documentType].toLowerCase()}`,
            error_code: "RECIPIENT_NOT_FOUND",
            documentType,
            documentId,
          }),
          { status: 422, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      recipientEmail = resolved as string;
    }

    // Get platform settings for email provider; identity is resolved by the
    // shared resolver so the document path uses the same tier as every
    // other tenant-facing surface (ADR 0023).
    const settings = await getPlatformSettings(supabaseClient);
    const emailProvider = settings.get("email_provider") || "resend";

    const { resolveSenderIdentity } = await import(
      "../_shared/branding/resolveSenderIdentity.ts"
    );
    const identity = await resolveSenderIdentity(supabaseClient, {
      category: "tenant_document",
      organization_id: document.organization_id,
      business_id: (document.business?.id as string | undefined) ?? null,
    });
    const platformFromEmail = identity.from_email;
    const effectiveFromName = identity.from_name;
    const effectiveReplyTo = identity.reply_to ?? undefined;
    console.log(
      `[send-document-email] document path sender_source=${identity.source} from="${effectiveFromName}"`,
    );

    // Get API key for provider
    let apiKey: string | null = null;
    switch (emailProvider) {
      case "resend":
        apiKey = settings.get("resend_api_key") ?? null;
        break;
      case "sendgrid":
        apiKey = settings.get("sendgrid_api_key") ?? null;
        break;
      case "mailgun":
        apiKey = settings.get("mailgun_api_key") ?? null;
        break;
    }

    if (!apiKey) {
      throw new Error(`Email provider (${emailProvider}) is not configured. Please configure it in Admin Settings.`);
    }

    const docNumber = documentType === "customer_statement"
      ? `${document.contact?.name || "Customer"} (${new Date(document.period_start).toLocaleDateString()} – ${new Date(document.period_end).toLocaleDateString()})`
      : documentType === "contract_letter"
        ? (document.contract_reference || `CONTRACT-${String(resolvedDocumentId).slice(0, 8).toUpperCase()}`)
      : documentType === "payslip"
        // Prefer the human-readable payslip_number; fall back to run + employee for legacy rows.
        ? (document.payslip_number
            || `${document.payroll_run?.payroll_number || "Payslip"} · ${document.contact?.first_name || ""} ${document.contact?.last_name || ""}`.trim())
        : document[tableConfig.numberField];
    const docLabel = documentLabels[documentType];
    // Customer-facing emails must NEVER leak the workspace/tenant name (Odoo/
    // Xero/QuickBooks rule: documents and their emails carry the legal-entity
    // identity only). If, for any reason, the joined `business` row is
    // missing, fall back to a neutral label rather than the workspace name.
    const senderIdentity =
      document.business?.legal_name || document.business?.name || "Your Provider";
    const emailSubject = subject || `${docLabel} ${docNumber} from ${senderIdentity}`;
    failureAudit = {
      client: supabaseClient,
      organization_id: document.organization_id,
      business_id: document.business_id ?? null,
      document_type: documentType,
      document_id: resolvedDocumentId,
      recipient_email: recipientEmail,
      subject: emailSubject,
      sent_by: user.id,
    };
    const emailHtml = generateEmailHtml(
      document,
      documentType,
      message,
      document.business || { name: senderIdentity },
    );

    // Prepare attachments array
    const attachments: Array<{ filename: string; content: string }> = [];
    let pdfStoragePath: string | null = null;
    let pdfFileSize: number | null = null;

    // Auto-generate PDF using the shared engine (single source of truth)
    if (autoGeneratePdf) {
      console.log("Auto-generating PDF for", documentType, docNumber);
      try {
        if (documentType === "payslip") {
          // Payslips use the dedicated branded engine.
          console.log("Generating payslip PDF for", resolvedDocumentId);
          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
          const pdfResponse = await fetch(`${supabaseUrl}/functions/v1/generate-payslip-pdf`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${userJwt}`,
            },
            body: JSON.stringify({ payslip_id: resolvedDocumentId }),
          });

          if (!pdfResponse.ok) {
            const errText = await pdfResponse.text();
            throw new Error(`Payslip PDF generation failed: ${errText}`);
          }

          const pdfArrayBuffer = await pdfResponse.arrayBuffer();
          const pdfBytes = new Uint8Array(pdfArrayBuffer);
          // `btoa(String.fromCharCode(...bytes))` overflows the argument
          // limit on multi-page PDFs; the std encoder streams instead.
          const pdfBase64Content = encodeBase64(pdfBytes);


          const safeDocNumber = String(docNumber || resolvedDocumentId).replace(/[^a-zA-Z0-9_-]/g, "_");
          const autoFilename = `payslip-${safeDocNumber}.pdf`;
          attachments.push({ filename: autoFilename, content: pdfBase64Content });
          pdfFileSize = pdfBytes.length;

          const storagePath = `${document.organization_id}/payslip/${resolvedDocumentId}/${Date.now()}.pdf`;
          const { error: uploadError } = await supabaseClient.storage
            .from("document-pdfs")
            .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: true });

          if (uploadError) console.error("Failed to store payslip PDF:", uploadError);
          else { pdfStoragePath = storagePath; console.log("Payslip PDF stored at:", storagePath); }
        } else {
          // Enterprise invariant: email ATTACHES the canonical artifact, it
          // does not render one of its own. `resolveCanonicalPdf` returns the
          // archived `document_artifacts` bytes when they exist, otherwise
          // renders the frozen `document_records.snapshot` through the ONE
          // render endpoint. Only kinds not yet on the document model fall
          // through to the legacy live-refetch generator below.
          console.log(`Resolving canonical ${documentType} PDF for`, resolvedDocumentId);
          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

          // Stage W5 (ADR-0008): consult the per-tenant print policy so the
          // emailed attachment matches what the operator would see if they
          // printed in-app. ESC/POS resolutions are coerced to PDF here — raw
          // thermal bytes are not a useful email attachment. Note this is a
          // *paper* override on one renderer, never a second renderer.
          const emailPolicy = await resolvePrintPolicy(supabaseClient as never, {
            businessId: document.business_id ?? null,
            branchId: document.branch_id ?? null,
            documentType,
          });
          const wasThermal = emailPolicy.render_mode === "escpos";
          if (wasThermal) {
            console.log(
              `[send-document-email] policy for ${documentType} resolved to ESC/POS — coerced to PDF for email attachment`,
            );
          }

          const canonical = await resolveCanonicalPdf({
            supabase: supabaseClient,
            documentType,
            documentId: resolvedDocumentId,
            paperFormat: emailPolicy.paper_format,
            authorization: `Bearer ${userJwt}`,
          });

          let pdfBytes: Uint8Array;
          if (canonical) {
            console.log(
              `[send-document-email] ${documentType} attachment source=${canonical.source}` +
                ` record=${canonical.documentRecordId} artifact=${canonical.artifactId ?? "new"}`,
            );
            pdfBytes = canonical.bytes;
          } else {
            // Legacy path — this document kind has no snapshot builder yet, so
            // there is nothing frozen to render. Logged loudly: every line of
            // this branch is a kind still owed a builder.
            console.warn(
              `[send-document-email] no document record for ${documentType}/${resolvedDocumentId};` +
                ` falling back to generate-document (live re-read, not archived)`,
            );
            const pdfResponse = await fetch(`${supabaseUrl}/functions/v1/generate-document`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userJwt}`,
              },
              body: JSON.stringify({
                documentType,
                documentId: resolvedDocumentId,
                format: "pdf",
                paperFormat: emailPolicy.paper_format,
                renderMode: "pdf",
              }),
            });

            if (!pdfResponse.ok) {
              const errText = await pdfResponse.text();
              throw new Error(`${docLabel} PDF generation failed: ${errText}`);
            }
            pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
          }

          const pdfBase64Content = encodeBase64(pdfBytes);


          const safeDocNumber = String(docNumber || resolvedDocumentId).replace(/[^a-zA-Z0-9_-]/g, "_");
          // Filename follows the document type — a contract emailed as
          // "payslip-*.pdf" (the old hardcoded stem) is a support ticket.
          const autoFilename = `${documentType.replace(/_/g, "-")}-${safeDocNumber}.pdf`;
          attachments.push({ filename: autoFilename, content: pdfBase64Content });
          pdfFileSize = pdfBytes.length;

          const storagePath = `${document.organization_id}/${documentType}/${resolvedDocumentId}/${Date.now()}.pdf`;
          const { error: uploadError } = await supabaseClient.storage
            .from("document-pdfs")
            .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: true });

          if (uploadError) console.error("Failed to store PDF:", uploadError);
          else { pdfStoragePath = storagePath; console.log("PDF stored at:", storagePath); }
        }
      } catch (pdfError) {
        console.error("PDF generation failed:", pdfError);
        // Don't fail the whole email - just log and continue without attachment
      }
    }
    
    // Add manual PDF attachment if provided
    if (attachPdf && pdfBase64) {
      attachments.push({
        filename: pdfFilename || `${docLabel.toLowerCase().replace(" ", "-")}-${docNumber}.pdf`,
        content: pdfBase64,
      });
    }

    // Send email based on provider
    let result;
    switch (emailProvider) {
      case "resend":
        result = await sendWithResend(
          apiKey,
          platformFromEmail,
          effectiveFromName,
          recipientEmail,
          ccEmails,
          bccEmails,
          emailSubject,
          emailHtml,
          effectiveReplyTo,
          attachments.length > 0 ? attachments : undefined
        );
        break;
      case "sendgrid":
        result = await sendWithSendGrid(
          apiKey,
          platformFromEmail,
          effectiveFromName,
          recipientEmail,
          ccEmails,
          bccEmails,
          emailSubject,
          emailHtml,
          effectiveReplyTo,
          attachments.length > 0 ? attachments : undefined
        );
        break;
      case "mailgun":
        const mailgunDomain = settings.get("mailgun_domain");
        if (!mailgunDomain) {
          throw new Error("Mailgun domain not configured");
        }
        result = await sendWithMailgun(
          apiKey,
          mailgunDomain,
          platformFromEmail,
          effectiveFromName,
          recipientEmail,
          ccEmails,
          bccEmails,
          emailSubject,
          emailHtml,
          effectiveReplyTo,
          attachments.length > 0 ? attachments : undefined
        );
        break;
      default:
        throw new Error(`Unknown email provider: ${emailProvider}`);
    }

    console.log("Email sent successfully:", result);

    // Log the email in document_emails table
    await supabaseClient.from("document_emails").insert({
      organization_id: document.organization_id,
      document_type: documentType,
      document_id: resolvedDocumentId,
      recipient_email: recipientEmail,
      cc_emails: ccEmails && ccEmails.length > 0 ? ccEmails : null,
      bcc_emails: bccEmails && bccEmails.length > 0 ? bccEmails : null,
      subject: emailSubject,
      message: message || null,
      status: "sent",
      had_attachment: attachments.length > 0,
      attachment_filename: attachments.length > 0 ? attachments[0].filename : null,
      sent_by: user.id,
      pdf_storage_path: pdfStoragePath,
      pdf_generated_at: autoGeneratePdf ? new Date().toISOString() : null,
      pdf_file_size_bytes: pdfFileSize,
    });

    // Update document status if applicable (set to 'sent' if draft)
    // IMPORTANT: For invoices, do NOT update status here — the frontend handles
    // confirmation + GL posting. Updating status here bypasses journal entry creation.
    if (tableConfig.statusField && document.status === "draft" && documentType !== "invoice") {
      await supabaseClient
        .from(tableConfig.table)
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", resolvedDocumentId);
    }
    // For invoices, only update sent_at timestamp (status is managed by frontend GL workflow)
    if (documentType === "invoice") {
      await supabaseClient
        .from(tableConfig.table)
        .update({ sent_at: new Date().toISOString() })
        .eq("id", resolvedDocumentId);
    }
    // For customer statements, mark as sent
    if (documentType === "customer_statement") {
      await supabaseClient
        .from("customer_statements")
        .update({ sent_at: new Date().toISOString(), sent_to: recipientEmail })
        .eq("id", resolvedDocumentId);
    }

    // NOTE: there is exactly one email/activity ledger — `document_emails`
    // (written above) plus `audit_logs`. The legacy write-only
    // `invoice_activities` mirror was retired; do not reintroduce a
    // per-document-type activity table.

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `${docLabel} email sent successfully`,
        pdfGenerated: autoGeneratePdf && attachments.length > 0,
        pdfStoragePath,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error sending document email:", error);
    if (failureAudit) {
      const { client, ...ctx } = failureAudit;
      try {
        await client.from("document_emails").insert({
          ...ctx,
          status: "failed",
          message: `Send failed: ${error?.message ?? "unknown error"}`,
          had_attachment: false,
        });
      } catch (auditError) {
        console.error("Failed to record failed send in document_emails:", auditError);
      }
    }
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
