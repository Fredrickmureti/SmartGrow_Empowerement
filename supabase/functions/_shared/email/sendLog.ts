// Persistent logging for outbound emails.
// Writes to platform_email_logs so the platform admin can audit
// every system/notification/document email sent through the stack.

export interface EmailSendLogEntry {
  template_key?: string | null;
  recipient_email: string;
  recipient_user_id?: string | null;
  recipient_org_id?: string | null;
  subject?: string | null;
  status: "sent" | "failed" | "skipped";
  reply_to?: string | null;
  resend_id?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

// deno-lint-ignore no-explicit-any
export async function logEmailSend(supabase: any, entry: EmailSendLogEntry): Promise<void> {
  try {
    const sentAt = entry.status === "sent" ? new Date().toISOString() : null;
    await supabase.from("platform_email_logs").insert({
      template_key: entry.template_key ?? null,
      recipient_email: entry.recipient_email,
      recipient_user_id: entry.recipient_user_id ?? null,
      recipient_org_id: entry.recipient_org_id ?? null,
      subject: entry.subject ?? null,
      status: entry.status,
      reply_to: entry.reply_to ?? null,
      resend_id: entry.resend_id ?? null,
      error_message: entry.error_message ?? null,
      metadata: entry.metadata ?? {},
      sent_at: sentAt,
    });
  } catch (err) {
    // Never block a successful send because logging failed.
    console.error("[email/sendLog] insert failed:", err);
  }
}
