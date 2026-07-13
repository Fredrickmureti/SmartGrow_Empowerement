/**
 * AdminEmailComposePage — routed workspace at
 * `/admin-management/email-center/compose` replacing
 * `ComposeEmailDialog`. Also reused by
 * `/admin-management/demo-requests/:id/reply` via `?demoRequestId=`.
 * See Platform Admin four-pattern rule in
 * `docs/design-system/audit/platform-admin.md`.
 */
// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Section } from "@/design-system";
import {
  AdminRecordForm,
  AdminFieldGrid,
  AdminFieldCell,
} from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Paperclip, X, FileText } from "lucide-react";
import { AdminAIEmailAssistant } from "@/components/admin/email/AdminAIEmailAssistant";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const LIST_PATH = "/admin-management/email-center";

interface AttachmentFile {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  base64: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AdminEmailComposePageProps {
  /** Pre-filled recipients (comma-separated or array). */
  defaultTo?: string | string[];
  defaultSubject?: string;
  defaultBody?: string;
  defaultIsHtml?: boolean;
  lockTo?: boolean;
  logMetadata?: Record<string, any>;
  onSent?: () => void;
  cancelHref?: string;
  title?: string;
  meta?: string;
}

export default function AdminEmailComposePage(props: AdminEmailComposePageProps = {}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Optional prefill from query string (e.g. quick compose triggered from another surface).
  const qsTo = params.get("to") ?? undefined;
  const qsSubject = params.get("subject") ?? undefined;

  const initialTo = Array.isArray(props.defaultTo)
    ? props.defaultTo.join(", ")
    : (props.defaultTo ?? qsTo ?? "");

  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState(props.defaultSubject ?? qsSubject ?? "");
  const [body, setBody] = useState(props.defaultBody ?? "");
  const [useHtml, setUseHtml] = useState(props.defaultIsHtml ?? false);
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Keep props changes in sync (used when embedded in reply page that fetches async).
  useEffect(() => {
    if (props.defaultTo !== undefined) {
      setTo(Array.isArray(props.defaultTo) ? props.defaultTo.join(", ") : props.defaultTo);
    }
    if (props.defaultSubject !== undefined) setSubject(props.defaultSubject);
    if (props.defaultBody !== undefined) setBody(props.defaultBody);
    if (props.defaultIsHtml !== undefined) setUseHtml(props.defaultIsHtml);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.defaultTo, props.defaultSubject, props.defaultBody, props.defaultIsHtml]);

  const totalAttachmentBytes = attachments.reduce((s, a) => s + a.size, 0);

  const parseAddresses = (value: string): string[] =>
    value.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean);

  const handleAddFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newOnes: AttachmentFile[] = [];
    for (const f of Array.from(files)) {
      if (totalAttachmentBytes + f.size > MAX_TOTAL_BYTES) {
        toast({
          title: "Attachment too large",
          description: `"${f.name}" would exceed the 20MB total attachment limit.`,
          variant: "destructive",
        });
        continue;
      }
      try {
        const base64 = await fileToBase64(f);
        newOnes.push({
          id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: f.name,
          size: f.size,
          contentType: f.type || "application/octet-stream",
          base64,
        });
      } catch (e: any) {
        toast({
          title: "Failed to read file",
          description: normalizeError(e).message || f.name,
          variant: "destructive",
        });
      }
    }
    setAttachments((prev) => [...prev, ...newOnes]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const recipients = parseAddresses(to);
    const ccList = parseAddresses(cc);
    const bccList = parseAddresses(bcc);

    if (recipients.length === 0) {
      toast({ title: "No recipients", description: "Enter at least one email address.", variant: "destructive" });
      return;
    }
    if (!subject.trim() || !body.trim()) {
      toast({ title: "Missing content", description: "Subject and message are required.", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke("send-admin-email", {
        body: {
          recipients,
          cc: ccList.length ? ccList : undefined,
          bcc: bccList.length ? bccList : undefined,
          subject,
          body,
          isHtml: useHtml,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.base64,
            contentType: a.contentType,
          })),
        },
      });
      if (error) throw error;

      try {
        await (supabase.from as any)("platform_email_logs").insert({
          recipient_email: recipients.join(", "),
          subject,
          html_body: useHtml ? body : null,
          status: "sent",
          sent_at: new Date().toISOString(),
          metadata: {
            ...(props.logMetadata || {}),
            cc: ccList,
            bcc: bccList,
            attachment_count: attachments.length,
            attachment_filenames: attachments.map((a) => a.filename),
          },
        });
      } catch (logErr) {
        console.warn("[AdminEmailComposePage] failed to log email:", logErr);
      }

      toast({
        title: "Email sent",
        description: `Delivered to ${recipients.length} recipient(s)${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}.`,
      });

      props.onSent?.();
      navigate(props.cancelHref ?? LIST_PATH);
    } catch (err: any) {
      console.error("[AdminEmailComposePage] send failed:", err);
      toast({
        title: "Failed to send",
        description: normalizeError(err).message || "Check email provider configuration in Email Center.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode="create"
      entityLabel={props.title ?? "Email"}
      meta={props.meta ?? "Compose and send an email directly from the platform."}
      cancelHref={props.cancelHref ?? LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Send email"
    >
      <Section title="Recipients" description="Who receives this message.">
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-to">To *</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowCcBcc((v) => !v)}
              >
                {showCcBcc ? "Hide Cc/Bcc" : "Add Cc/Bcc"}
              </button>
            </div>
            <Input
              id="compose-to"
              placeholder="recipient@example.com, another@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={props.lockTo || isSubmitting}
            />
          </div>
        </AdminFieldCell>
        {showCcBcc && (
          <AdminFieldGrid columns={2}>
            <div className="space-y-2">
              <Label htmlFor="compose-cc">Cc</Label>
              <Input id="compose-cc" placeholder="cc@example.com" value={cc}
                onChange={(e) => setCc(e.target.value)} disabled={isSubmitting} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="compose-bcc">Bcc</Label>
              <Input id="compose-bcc" placeholder="bcc@example.com" value={bcc}
                onChange={(e) => setBcc(e.target.value)} disabled={isSubmitting} />
            </div>
          </AdminFieldGrid>
        )}
      </Section>

      <Section title="Content" description="Subject line and body of the email.">
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-subject">Subject *</Label>
              <AdminAIEmailAssistant
                currentSubject={subject}
                currentBody={body}
                isHtml={useHtml}
                onSubjectUpdate={setSubject}
                onBodyUpdate={setBody}
                onHtmlToggle={setUseHtml}
              />
            </div>
            <Input
              id="compose-subject"
              placeholder="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
        </AdminFieldCell>
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-body">Message *</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="compose-html" className="text-xs text-muted-foreground">HTML</Label>
                <Switch id="compose-html" checked={useHtml} onCheckedChange={setUseHtml} disabled={isSubmitting} />
              </div>
            </div>
            <Textarea
              id="compose-body"
              placeholder={useHtml ? "<p>Write HTML here…</p>" : "Write your message…"}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className={useHtml ? "font-mono text-sm" : "text-sm"}
              disabled={isSubmitting}
            />
          </div>
        </AdminFieldCell>
      </Section>

      <Section title="Attachments" description="Up to 20MB total per email.">
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Files</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSubmitting}
              >
                <Paperclip className="h-3.5 w-3.5 mr-1.5" /> Add files
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => handleAddFiles(e.target.files)}
              />
            </div>
            {attachments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No attachments.</p>
            ) : (
              <div className="space-y-1.5">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{a.filename}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {formatSize(a.size)}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => removeAttachment(a.id)}
                      disabled={isSubmitting}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Total: {formatSize(totalAttachmentBytes)} / 20.0 MB
                </p>
              </div>
            )}
          </div>
        </AdminFieldCell>
      </Section>
    </AdminRecordForm>
  );
}