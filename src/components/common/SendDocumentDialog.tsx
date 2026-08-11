import { useState, useRef, ChangeEvent, useEffect } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Mail, Paperclip, X, FileText, Plus } from "lucide-react";
import { AIEmailAssistant } from "@/components/email/AIEmailAssistant";
import { normalizeError } from "@/services/resilience";

export type DocumentType = "invoice" | "estimate" | "proforma" | "credit_note" | "delivery_note" | "purchase_order" | "bill" | "customer_statement" | "vendor_statement" | "receipt" | "sales_return" | "sales_order" | "payslip" | "pos_receipt" | "contract_letter" | "purchase_return";

export interface DocumentEmailData {
  documentType: DocumentType;
  documentId: string;
  documentNumber: string;
  recipientEmail?: string;
  recipientName?: string;
  total?: number;
  currency?: string;
}

/**
 * Bulk-send mode: when provided, the dialog fans out one
 * `send-document-email` call per id (no per-recipient email field shown — the
 * recipient is resolved server-side from each document's contact). All ids
 * must share `documentType`.
 */
export interface BulkSendData {
  documentType: DocumentType;
  documentIds: string[];
  /** Optional human label for the dialog header (e.g., "Payroll PR-2025-04"). */
  scopeLabel?: string;
}

interface SendDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document?: DocumentEmailData | null;
  bulk?: BulkSendData | null;
  onSuccess?: () => void;
}

const getDocumentLabel = (type: DocumentType): string => {
  const labels: Record<DocumentType, string> = {
    invoice: "Invoice",
    estimate: "Estimate",
    proforma: "Proforma Invoice",
    credit_note: "Credit Note",
    delivery_note: "Delivery Note",
    purchase_order: "Purchase Order",
    bill: "Bill",
    customer_statement: "Customer Statement",
    vendor_statement: "Vendor Statement",
    receipt: "Payment Receipt",
    sales_return: "Sales Return",
    purchase_return: "Purchase Return",
    sales_order: "Sales Order",
    payslip: "Payslip",
    pos_receipt: "Sales Receipt",
    contract_letter: "Employment Contract",
  };
  return labels[type];
};

export function SendDocumentDialog({
  open,
  onOpenChange,
  document,
  bulk,
  onSuccess,
}: SendDocumentDialogProps) {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBulk = !!bulk && bulk.documentIds.length > 0;
  const effectiveType: DocumentType | null = isBulk ? bulk!.documentType : document?.documentType ?? null;
  const effectiveLabel = effectiveType ? getDocumentLabel(effectiveType) : "";

  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [formData, setFormData] = useState({
    recipientEmail: "",
    ccEmails: "",
    bccEmails: "",
    subject: "",
    message: "",
  });

  // Auto-generate PDF toggle (Odoo-style: ON by default)
  const [autoGeneratePdf, setAutoGeneratePdf] = useState(true);

  // Manual attachment support
  const [showManualAttachment, setShowManualAttachment] = useState(false);
  const [manualPdfFile, setManualPdfFile] = useState<File | null>(null);

  // Reset form when dialog opens with new document
  const resetForm = () => {
    const orgName = currentOrg?.name || "Our Company";
    if (isBulk && effectiveType) {
      const docLabel = effectiveLabel;
      setFormData({
        recipientEmail: "",
        ccEmails: "",
        bccEmails: "",
        subject: `Your ${docLabel.toLowerCase()} from ${orgName}`,
        message: `Dear Recipient,\n\nPlease find your ${docLabel.toLowerCase()} attached.\n\nBest regards,\n${orgName}`,
      });
    } else if (document) {
      const docLabel = getDocumentLabel(document.documentType);
      setFormData({
        recipientEmail: document.recipientEmail || "",
        ccEmails: "",
        bccEmails: "",
        subject: `${docLabel} ${document.documentNumber} from ${orgName}`,
        message: document.documentType === "contract_letter"
          ? `Dear ${document.recipientName || "Colleague"},\n\nPlease find attached your employment contract ${document.documentNumber}.\n\nKindly review, sign, and return a copy. Reach out to HR if anything needs clarifying.\n\nBest regards,\n${orgName}`
          : document.documentType === "purchase_order"
          ? `Dear ${document.recipientName || "Supplier"},\n\nPlease find attached ${docLabel.toLowerCase()} ${document.documentNumber}${document.total && document.currency ? ` for ${document.currency} ${document.total.toFixed(2)}` : ""}.\n\nPlease confirm receipt and expected delivery date at your earliest convenience.\n\nBest regards,\n${orgName}`
          : `Dear ${document.recipientName || "Customer"},\n\nPlease find attached ${docLabel.toLowerCase()} ${document.documentNumber}${document.total && document.currency ? ` for ${document.currency} ${document.total.toFixed(2)}` : ""}.\n\nIf you have any questions, please don't hesitate to contact us.\n\nBest regards,\n${orgName}`,
      });
    }
    setAutoGeneratePdf(true);
    setShowManualAttachment(false);
    setManualPdfFile(null);
    setProgress(null);
  };

  // Reset form when document changes
  useEffect(() => {
    if (open) {
      resetForm();
    }
  }, [open, document?.documentId, isBulk, bulk?.documentIds.join(",")]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type !== "application/pdf") {
        toast({
          title: "Invalid file type",
          description: "Please upload a PDF file.",
          variant: "destructive",
        });
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Maximum file size is 10MB.",
          variant: "destructive",
        });
        return;
      }
      setManualPdfFile(file);
    }
  };

  const removeManualFile = () => {
    setManualPdfFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isBulk && (!document || !formData.recipientEmail)) {
      toast({
        title: "Missing information",
        description: "Please enter recipient email.",
        variant: "destructive",
      });
      return;
    }
    if (isBulk && bulk!.documentIds.length === 0) {
      toast({ title: "Nothing to send", description: "No documents selected.", variant: "destructive" });
      return;
    }

    setIsLoading(true);

    try {
      let manualPdfBase64: string | undefined;

      if (showManualAttachment && manualPdfFile) {
        const arrayBuffer = await manualPdfFile.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
        manualPdfBase64 = btoa(binary);
      }

      const ccEmails = formData.ccEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const bccEmails = formData.bccEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

      if (isBulk) {
        const ids = bulk!.documentIds;
        setProgress({ done: 0, total: ids.length });
        let succeeded = 0;
        const failures: string[] = [];
        for (const id of ids) {
          try {
            const { data, error } = await supabase.functions.invoke("send-document-email", {
              body: {
                documentType: bulk!.documentType,
                documentId: id,
                // Server resolves the recipient from the row's contact when omitted.
                resolveRecipientFromRow: true,
                subject: formData.subject,
                message: formData.message,
                autoGeneratePdf: autoGeneratePdf,
                ccEmails: ccEmails.length > 0 ? ccEmails : undefined,
                bccEmails: bccEmails.length > 0 ? bccEmails : undefined,
              },
            });
            if (error || (data && data.success === false)) {
              failures.push(id);
            } else {
              succeeded++;
            }
          } catch {
            failures.push(id);
          }
          setProgress({ done: succeeded + failures.length, total: ids.length });
        }
        if (failures.length === 0) {
          toast({ title: "All emails sent", description: `${succeeded} ${effectiveLabel.toLowerCase()}${succeeded === 1 ? "" : "s"} sent.` });
        } else {
          toast({
            title: `${succeeded}/${ids.length} sent`,
            description: failures.length === ids.length ? "All sends failed." : `${failures.length} failed; check audit log.`,
            variant: failures.length === ids.length ? "destructive" : "default",
          });
        }
        onOpenChange(false);
        onSuccess?.();
        return;
      }

      const { data, error } = await supabase.functions.invoke("send-document-email", {
        body: {
          documentType: document!.documentType,
          documentId: document!.documentId,
          recipientEmail: formData.recipientEmail,
          ccEmails: ccEmails.length > 0 ? ccEmails : undefined,
          bccEmails: bccEmails.length > 0 ? bccEmails : undefined,
          subject: formData.subject,
          message: formData.message,
          autoGeneratePdf: autoGeneratePdf,
          attachPdf: showManualAttachment && manualPdfFile ? true : false,
          pdfBase64: manualPdfBase64,
          pdfFilename: manualPdfFile?.name,
        },
      });

      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.error || "Failed to send email");
      }

      toast({
        title: "Email sent successfully",
        description: `${getDocumentLabel(document!.documentType)} sent to ${formData.recipientEmail}${autoGeneratePdf ? " with PDF attachment" : ""}`,
      });

      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      console.error("Error sending email:", error);
      toast({
        title: "Error sending email",
        description: normalizeError(error).message || "Failed to send email. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!document && !isBulk) return null;

  const docLabel = effectiveLabel;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {isBulk ? `Email ${bulk!.documentIds.length} ${docLabel}${bulk!.documentIds.length === 1 ? "" : "s"}` : `Send ${docLabel} via Email`}
          </DialogTitle>
          <DialogDescription>
            {isBulk
              ? `Each ${docLabel.toLowerCase()} is sent individually to the recipient on file${bulk!.scopeLabel ? ` · ${bulk!.scopeLabel}` : ""}.`
              : `Send ${docLabel.toLowerCase()} ${document!.documentNumber} to your customer`}

          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isBulk && (
            <div className="space-y-2">
              <Label htmlFor="recipientEmail">Recipient Email *</Label>
              <Input
                id="recipientEmail"
                type="email"
                placeholder="customer@example.com"
                value={formData.recipientEmail}
                onChange={(e) =>
                  setFormData({ ...formData, recipientEmail: e.target.value })
                }
                required
              />
            </div>
          )}
          {isBulk && progress && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              Sending {progress.done} of {progress.total}…
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ccEmails">CC (comma separated)</Label>
              <Input
                id="ccEmails"
                type="text"
                placeholder="cc1@example.com, cc2@example.com"
                value={formData.ccEmails}
                onChange={(e) =>
                  setFormData({ ...formData, ccEmails: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bccEmails">BCC (comma separated)</Label>
              <Input
                id="bccEmails"
                type="text"
                placeholder="bcc@example.com"
                value={formData.bccEmails}
                onChange={(e) =>
                  setFormData({ ...formData, bccEmails: e.target.value })
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              type="text"
              value={formData.subject}
              onChange={(e) =>
                setFormData({ ...formData, subject: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="message">Message</Label>
              <AIEmailAssistant
                currentMessage={formData.message}
                onMessageUpdate={(message) => setFormData({ ...formData, message })}
                context={{
                  documentType: effectiveType ?? "invoice",
                  documentNumber: isBulk ? (bulk!.scopeLabel || `${bulk!.documentIds.length} items`) : (document?.documentNumber ?? ""),
                  recipientName: document?.recipientName,
                  total: document?.total,
                  currency: document?.currency,
                  organizationName: currentOrg?.name,
                }}
              />
            </div>
            <Textarea
              id="message"
              rows={6}
              value={formData.message}
              onChange={(e) =>
                setFormData({ ...formData, message: e.target.value })
              }
              placeholder="Enter your message..."
            />
          </div>

          {/* PDF Attachment Section - Odoo Style */}
          <div className="space-y-4 rounded-lg border p-4">
            {/* Auto-generate PDF toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-primary" />
                <div className="space-y-0.5">
                  <Label htmlFor="autoGeneratePdf" className="font-medium">
                    Auto-generate PDF
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {autoGeneratePdf 
                      ? "System will generate a professional PDF with logo, bank details & custom fields" 
                      : "No automatic PDF will be attached. Use manual upload below if needed."}
                  </p>
                </div>
              </div>
              <Switch
                id="autoGeneratePdf"
                checked={autoGeneratePdf}
                onCheckedChange={(checked) => {
                  setAutoGeneratePdf(checked);
                  // If turning off auto-generate, show manual option
                  if (!checked) {
                    setShowManualAttachment(true);
                  }
                }}
              />
            </div>

            {autoGeneratePdf && (
              <div className="flex items-center gap-2 rounded-md bg-accent/50 border border-primary/20 p-3 text-sm">
                <Paperclip className="h-4 w-4 text-primary" />
                <span className="text-foreground">
                  <strong>{docLabel.toLowerCase()}-{isBulk ? "[per-recipient]" : document?.documentNumber}.pdf</strong> will be auto-generated with full template
                </span>
              </div>
            )}

            {/* Separator */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Additional attachments
                </span>
              </div>
            </div>

            {/* Manual attachment option */}
            {!showManualAttachment ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setShowManualAttachment(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add custom attachment
              </Button>
            ) : (
              <div className="space-y-2">
                {manualPdfFile ? (
                  <div className="flex items-center justify-between rounded-md border p-3 bg-muted/50">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{manualPdfFile.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({(manualPdfFile.size / 1024).toFixed(1)} KB)
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={removeManualFile}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={handleFileChange}
                      className="hidden"
                      id="manual-pdf-upload"
                    />
                    <div className="flex gap-2">
                      <label htmlFor="manual-pdf-upload" className="flex-1">
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full cursor-pointer"
                          asChild
                        >
                          <span>
                            <Paperclip className="mr-2 h-4 w-4" />
                            Select PDF File
                          </span>
                        </Button>
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowManualAttachment(false)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Send Email
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
