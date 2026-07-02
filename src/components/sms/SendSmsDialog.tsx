import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, MessageSquare, FlaskConical, Radio, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useSmsTemplates } from "@/hooks/useSmsTemplates";
import { useSmsConfig, type SmsEdgeResponse } from "@/hooks/useSmsConfig";
import { toast } from "sonner";
import { SmsCharCounter } from "./SmsCharCounter";
import { normalizeE164, isValidE164 } from "@/lib/sms/phone";

const ERROR_HINTS: Record<string, string> = {
  CONFIG_MISSING: "SMS is not configured for this organization. Open Settings → SMS to set it up.",
  INVALID_RECIPIENT: "Recipient phone is not in E.164 format (e.g. +14155552671) or was rejected by Twilio.",
  INVALID_SENDER: "Sender is not configured correctly for live mode. Check sender phone or Messaging Service in SMS settings.",
  TEST_MODE_UNSUPPORTED_PARAM: "Twilio test credentials don't support Messaging Service SID. Switch to live mode or remove it.",
  TEST_CREDENTIALS_MISMATCH: "You selected Test mode but the credentials look like Live credentials. Either paste your Twilio Test Credentials (separate from Live keys), or switch to Live mode in SMS settings.",
  TWILIO_AUTH_FAILED: "Twilio rejected the credentials. Update Account SID / Auth Token in SMS settings.",
  TOLLFREE_NOT_VERIFIED: "Your toll-free number isn't verified yet. Complete Twilio toll-free verification before sending.",
  RECIPIENT_OPTED_OUT: "This recipient previously opted out of SMS from your sender (Twilio STOP).",
  SENDER_NOT_OWNED: "The sender number isn't on this Twilio account or isn't SMS-capable.",
  UNREACHABLE_CARRIER: "The destination carrier is unreachable from your sender.",
  MESSAGE_EMPTY: "Message body is empty.",
  RATE_LIMITED: "Daily SMS limit for this organization has been reached.",
  OPTED_OUT: "Recipient is on this organization's opt-out list.",
  PERMISSION_DENIED: "You don't have permission to send SMS for this organization.",
};

interface SendSmsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientPhone?: string;
  recipientName?: string;
  /** Pre-fill template variables */
  variables?: Record<string, string>;
  /** Context: which document is this SMS about */
  context?: {
    entityType: string;
    entityId: string;
    businessId?: string;
  };
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

export function SendSmsDialog({
  open,
  onOpenChange,
  recipientPhone = "",
  recipientName,
  variables = {},
  context,
}: SendSmsDialogProps) {
  const { currentOrg } = useOrganization();
  const { templates } = useSmsTemplates();
  const { config } = useSmsConfig();
  const [phone, setPhone] = useState(recipientPhone);
  const [message, setMessage] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);

  const isConfigured = !!config?.id && config.is_enabled;
  const providerMode = config?.provider_mode ?? "test";

  // When dialog opens with new recipientPhone, update
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setPhone(recipientPhone);
      setMessage("");
      setSelectedTemplate("");
    }
    onOpenChange(newOpen);
  };

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);
    const tpl = templates.find((t) => t.id === templateId);
    if (tpl) {
      setMessage(substituteVariables(tpl.body_template, variables));
    }
  };

  const handleSend = async () => {
    if (!phone || !message || !currentOrg?.id) return;
    setLastError(null);
    // Try to normalize before validating; if normalization succeeds, persist it.
    const normalized = normalizeE164(phone) ?? phone;
    if (normalized !== phone) setPhone(normalized);
    if (!isValidE164(normalized)) {
      setLastError({ code: "INVALID_RECIPIENT", message: ERROR_HINTS.INVALID_RECIPIENT });
      return;
    }
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-sms", {
        body: {
          organization_id: currentOrg.id,
          business_id: context?.businessId || null,
          recipient_phone: phone,
          custom_message: message,
        },
      });
      // The edge function returns 200 with structured body for handled errors.
      // Recover that body when supabase-js still surfaces an `error` (non-2xx-like path).
      let resp = data as SmsEdgeResponse | null;
      if (!resp && error) {
        const ctx = (error as unknown as { context?: { body?: unknown } })?.context;
        if (ctx?.body) {
          try {
            const text = typeof ctx.body === "string" ? ctx.body : await (ctx.body as Response).text?.();
            if (text) resp = JSON.parse(text) as SmsEdgeResponse;
          } catch { /* ignore parse */ }
        }
        if (!resp) throw error;
      }
      if (resp?.success) {
        toast.success(
          resp.mode === "test"
            ? "SMS simulated (test mode — Twilio did not deliver a real message)."
            : "SMS sent successfully."
        );
        onOpenChange(false);
      } else {
        const code = resp?.code || "UNKNOWN_ERROR";
        const friendly = ERROR_HINTS[code] || resp?.message || "SMS could not be sent.";
        setLastError({ code, message: friendly });
        toast.error(friendly);
      }
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      setLastError({ code: "UNKNOWN_ERROR", message: msg });
      toast.error("Failed to send SMS: " + msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Send SMS
            {isConfigured && (
              <Badge variant={providerMode === "live" ? "default" : "secondary"} className="ml-2 gap-1">
                {providerMode === "live" ? <Radio className="h-3 w-3" /> : <FlaskConical className="h-3 w-3" />}
                {providerMode === "live" ? "Live" : "Test"}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {recipientName ? `Send an SMS to ${recipientName}` : "Send an SMS notification"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isConfigured && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                SMS is not configured or is disabled for this organization. Open Settings → SMS to enable it.
              </AlertDescription>
            </Alert>
          )}

          {isConfigured && providerMode === "test" && (
            <Alert>
              <FlaskConical className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Test mode — Twilio will accept the request but no real SMS will be delivered.
                Use <code className="font-mono">+15005550006</code> as the recipient to simulate success.
              </AlertDescription>
            </Alert>
          )}

          {lastError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium text-xs uppercase tracking-wide mb-0.5">{lastError.code}</div>
                <div className="text-sm">{lastError.message}</div>
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="sms-phone">Recipient Phone</Label>
            <Input
              id="sms-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1234567890"
            />
          </div>

          {templates.length > 0 && (
            <div className="space-y-2">
              <Label>Use Template (optional)</Label>
              <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template..." />
                </SelectTrigger>
                <SelectContent>
                  {templates
                    .filter((t) => t.is_active)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="sms-message">Message</Label>
            <Textarea
              id="sms-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Type your message..."
            />
            <SmsCharCounter text={message} />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={sending || !phone || !message || !isConfigured}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send SMS
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
