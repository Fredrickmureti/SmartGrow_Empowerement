// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Send,
  Loader2,
  Paperclip,
  X,
  FileText,
} from "lucide-react";
import { AdminAIEmailAssistant } from "./AdminAIEmailAssistant";
import { normalizeError } from "@/services/resilience";

export interface ComposeEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled recipients (comma-separated or array). */
  defaultTo?: string | string[];
  defaultSubject?: string;
  defaultBody?: string;
  defaultIsHtml?: boolean;
  /** Lock the To field (e.g. when replying to a specific request). */
  lockTo?: boolean;
  /** Optional metadata stored with the email log row. */
  logMetadata?: Record<string, any>;
  /** Callback after a successful send (e.g. to mark request as contacted). */
  onSent?: () => void;
  title?: string;
  description?: string;
}

const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20MB

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
      // result = "data:<mime>;base64,<payload>"
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

export function ComposeEmailDialog({
  open,
  onOpenChange,
  defaultTo,
  defaultSubject = "",
  defaultBody = "",
  defaultIsHtml = false,
  lockTo = false,
  logMetadata,
  onSent,
  title = "Compose Email",
  description = "Send an email directly from the platform — no need to leave the system.",
}: ComposeEmailDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const initialTo = Array.isArray(defaultTo) ? defaultTo.join(", ") : (defaultTo ?? "");

  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [useHtml, setUseHtml] = useState(defaultIsHtml);
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isSending, setIsSending] = useState(false);

  const totalAttachmentBytes = attachments.reduce((s, a) => s + a.size, 0);

  const resetForm = () => {
    setTo(initialTo);
    setCc("");
    setBcc("");
    setShowCcBcc(false);
    setSubject(defaultSubject);
    setBody(defaultBody);
    setUseHtml(defaultIsHtml);
    setAttachments([]);
  };

  const handleClose = (next: boolean) => {
    if (!next && !isSending) {
      onOpenChange(false);
      // Slight delay so the dialog closes cleanly before resetting
      setTimeout(resetForm, 150);
    } else {
      onOpenChange(next);
    }
  };

  const parseAddresses = (value: string): string[] =>
    value
      .split(/[,;\n]/)
      .map((v) => v.trim())
      .filter(Boolean);

  const handleAddFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const newOnes: AttachmentFile[] = [];
    for (const f of Array.from(files)) {
      // Reject if a single file would push total > limit
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

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSend = async () => {
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

    setIsSending(true);
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

      // Best-effort log entry (non-blocking)
      try {
        await (supabase.from as any)("platform_email_logs").insert({
          recipient_email: recipients.join(", "),
          subject,
          html_body: useHtml ? body : null,
          status: "sent",
          sent_at: new Date().toISOString(),
          metadata: {
            ...(logMetadata || {}),
            cc: ccList,
            bcc: bccList,
            attachment_count: attachments.length,
            attachment_filenames: attachments.map((a) => a.filename),
          },
        });
      } catch (logErr) {
        console.warn("[ComposeEmailDialog] failed to log email:", logErr);
      }

      toast({
        title: "Email sent",
        description: `Delivered to ${recipients.length} recipient(s)${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}.`,
      });

      onSent?.();
      handleClose(false);
    } catch (err: any) {
      console.error("[ComposeEmailDialog] send failed:", err);
      toast({
        title: "Failed to send",
        description: normalizeError(err).message || "Check email provider configuration in Email Center.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* To */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-to">To</Label>
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
              disabled={lockTo || isSending}
            />
          </div>

          {showCcBcc && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="compose-cc">Cc</Label>
                <Input
                  id="compose-cc"
                  placeholder="cc@example.com"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  disabled={isSending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="compose-bcc">Bcc</Label>
                <Input
                  id="compose-bcc"
                  placeholder="bcc@example.com"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  disabled={isSending}
                />
              </div>
            </div>
          )}

          {/* Subject + AI assist */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-subject">Subject</Label>
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
              disabled={isSending}
            />
          </div>

          {/* Body */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-body">Message</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="compose-html" className="text-xs text-muted-foreground">
                  HTML
                </Label>
                <Switch
                  id="compose-html"
                  checked={useHtml}
                  onCheckedChange={setUseHtml}
                  disabled={isSending}
                />
              </div>
            </div>
            <Textarea
              id="compose-body"
              placeholder={useHtml ? "<p>Write HTML here…</p>" : "Write your message…"}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className={useHtml ? "font-mono text-sm" : "text-sm"}
              disabled={isSending}
            />
          </div>

          {/* Attachments */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Attachments</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSending}
              >
                <Paperclip className="h-3.5 w-3.5 mr-1.5" />
                Add files
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
              <p className="text-xs text-muted-foreground">
                No attachments. Max 20MB total per email.
              </p>
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
                      disabled={isSending}
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
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => handleClose(false)} disabled={isSending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={isSending}>
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Send
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
