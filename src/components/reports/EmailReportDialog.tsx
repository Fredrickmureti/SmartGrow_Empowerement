import { normalizeError } from "@/services/resilience";
/**
 * EmailReportDialog
 *
 * Renders the same PDF the user would download via "Download as PDF",
 * base64-encodes it, and ships it to the `send-document-email` edge
 * function under the `report` documentType. Uses the platform email
 * provider already configured for invoices/bills/statements — no parallel
 * email pipeline. Logs to `document_emails` so accountants get the same
 * "who sent which report when" audit they get for outbound documents.
 */

import { useEffect, useState } from "react";
import { Loader2, Mail, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AIEmailAssistant } from "@/components/email/AIEmailAssistant";

import { supabase } from "@/integrations/supabase/client";
import {
  generateReportPdfBlob,
  type ExportConfig,
} from "@/services/reports/ReportExportService";

interface EmailReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Returns the FULLY ENRICHED ExportConfig (with org/branding context). */
  buildConfig: () => ExportConfig | Promise<ExportConfig>;
  /**
   * Optional default recipient (e.g. selected vendor's email on a vendor
   * statement page). User can still edit/remove.
   */
  defaultRecipientEmail?: string | null;
  /** Hint stored in the audit row, e.g. "vendor_statement", "aged_payables". */
  reportSubtype?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => {
      const result = reader.result as string;
      // result is "data:application/pdf;base64,XXXX" — strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
}

export function EmailReportDialog({
  open,
  onOpenChange,
  buildConfig,
  defaultRecipientEmail,
  reportSubtype,
}: EmailReportDialogProps) {
  const [toInput, setToInput] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attach, setAttach] = useState(true);
  const [isSending, setIsSending] = useState(false);

  // Resolve config once per open so we can prefill subject from title. The
  // builder may be async (server-paginated reports fetch the full dataset).
  const [previewConfig, setPreviewConfig] = useState<ExportConfig | null>(null);
  useEffect(() => {
    if (!open) {
      setPreviewConfig(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const cfg = await buildConfig();
      if (!cancelled) setPreviewConfig(cfg);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, buildConfig]);

  useEffect(() => {
    if (!open) return;
    setRecipients(defaultRecipientEmail && EMAIL_RE.test(defaultRecipientEmail)
      ? [defaultRecipientEmail]
      : []);
    setToInput("");
    setCc("");
    setBcc("");
    const cfg = previewConfig;
    const title = cfg?.title ?? "Report";
    const range = cfg?.dateRange ? ` — ${cfg.dateRange}` : "";
    setSubject(`${title}${range}`);
    setMessage(
      cfg?.subtitle
        ? `Please find attached the ${title.toLowerCase()} (${cfg.subtitle}).`
        : `Please find attached the ${title.toLowerCase()}.`,
    );
    setAttach(true);
  }, [open, defaultRecipientEmail, previewConfig]);

  const commitTyped = () => {
    const raw = toInput.trim().replace(/[,;]+$/, "");
    if (!raw) return;
    if (!EMAIL_RE.test(raw)) {
      toast.error(`"${raw}" is not a valid email address`);
      return;
    }
    if (!recipients.includes(raw)) setRecipients((r) => [...r, raw]);
    setToInput("");
  };

  const removeRecipient = (e: string) =>
    setRecipients((r) => r.filter((x) => x !== e));

  const parseList = (s: string): string[] =>
    s
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  const handleSend = async () => {
    // Commit any unsubmitted typed value first.
    if (toInput.trim()) commitTyped();
    const finalRecipients = [
      ...recipients,
      ...(toInput.trim() && EMAIL_RE.test(toInput.trim()) && !recipients.includes(toInput.trim())
        ? [toInput.trim()]
        : []),
    ];
    if (finalRecipients.length === 0) {
      toast.error("Add at least one recipient");
      return;
    }
    const ccList = parseList(cc);
    const bccList = parseList(bcc);
    const invalidCc = ccList.find((e) => !EMAIL_RE.test(e));
    const invalidBcc = bccList.find((e) => !EMAIL_RE.test(e));
    if (invalidCc) return toast.error(`Invalid CC address: ${invalidCc}`);
    if (invalidBcc) return toast.error(`Invalid BCC address: ${invalidBcc}`);

    const cfg = await buildConfig();
    if (!cfg.organizationId) {
      toast.error("Cannot send: organization context is missing.");
      return;
    }

    setIsSending(true);
    const t = toast.loading("Generating PDF…");
    try {
      let pdfBase64: string | undefined;
      let filename: string | undefined;
      if (attach) {
        const blob = await generateReportPdfBlob(cfg);
        pdfBase64 = await blobToBase64(blob);
        filename = `${sanitizeFilename(cfg.title)}_${format(new Date(), "yyyy-MM-dd")}.pdf`;
      }

      toast.loading(`Sending to ${finalRecipients.length} recipient(s)…`, { id: t });

      // Send one request per primary recipient so each gets a personalized
      // To: header (Resend treats multi-To as group send, which can leak
      // recipient lists). CC/BCC are per-send.
      const errors: string[] = [];
      for (const rcpt of finalRecipients) {
        const { error } = await supabase.functions.invoke("send-document-email", {
          body: {
            documentType: "report",
            recipientEmail: rcpt,
            ccEmails: ccList.length ? ccList : undefined,
            bccEmails: bccList.length ? bccList : undefined,
            subject,
            message,
            organizationId: cfg.organizationId,
            businessId: (cfg as any).businessId ?? undefined,
            reportTitle: cfg.title,
            reportSubtype,
            reportPeriod: cfg.dateRange,
            pdfBase64,
            pdfFilename: filename,
          },
        });
        if (error) errors.push(`${rcpt}: ${error.message}`);
      }

      if (errors.length === 0) {
        toast.success(`Report emailed to ${finalRecipients.length} recipient(s)`, { id: t });
        onOpenChange(false);
      } else if (errors.length < finalRecipients.length) {
        toast.warning(
          `Sent to ${finalRecipients.length - errors.length} of ${finalRecipients.length}. Failures: ${errors.join("; ")}`,
          { id: t },
        );
      } else {
        toast.error(`Failed to send: ${errors[0]}`, { id: t });
      }
    } catch (err: any) {
      console.error("Email report failed:", err);
      toast.error(`Failed to send report: ${normalizeError(err).message || "unknown error"}`, { id: t });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !isSending && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> Email report
          </DialogTitle>
          <DialogDescription>
            Send <strong>{previewConfig?.title ?? "this report"}</strong>
            {previewConfig?.dateRange ? ` (${previewConfig.dateRange})` : ""} as a
            PDF attachment using your configured email provider.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="report-to">To</Label>
            <div className="flex flex-wrap gap-1 rounded-md border bg-background px-2 py-1.5 min-h-10">
              {recipients.map((r) => (
                <Badge key={r} variant="secondary" className="gap-1">
                  {r}
                  <button
                    type="button"
                    onClick={() => removeRecipient(r)}
                    className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                    aria-label={`Remove ${r}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <input
                id="report-to"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === ";") {
                    e.preventDefault();
                    commitTyped();
                  }
                }}
                onBlur={commitTyped}
                placeholder={recipients.length === 0 ? "name@example.com" : ""}
                className="flex-1 min-w-[10rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="report-cc">CC</Label>
              <Input
                id="report-cc"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="comma separated"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-bcc">BCC</Label>
              <Input
                id="report-bcc"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                placeholder="comma separated"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="report-subject">Subject</Label>
            <Input
              id="report-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="report-message">Message</Label>
              <AIEmailAssistant
                currentMessage={message}
                onMessageUpdate={setMessage}
                context={{
                  documentType: "report",
                  documentNumber: previewConfig?.title ?? "Report",
                  organizationName: (previewConfig as any)?.companyName,
                }}
              />
            </div>
            <Textarea
              id="report-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <Label htmlFor="report-attach" className="cursor-pointer">
                Attach PDF
              </Label>
              <p className="text-xs text-muted-foreground">
                Identical to the "Download as PDF" output.
              </p>
            </div>
            <Switch id="report-attach" checked={attach} onCheckedChange={setAttach} />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={isSending} className="gap-2">
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {isSending ? "Sending…" : "Send report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EmailReportDialog;
