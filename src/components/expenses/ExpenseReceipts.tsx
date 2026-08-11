/**
 * ExpenseReceipts — canonical multi-receipt trail (expense_attachments).
 *
 * Only rendered once the expense exists; before that the legacy single
 * `receipt_url` upload is used. Add/remove is server-authoritative: RLS
 * rejects mutations once the expense leaves an open status.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FileImage, Loader2, Upload, X, ExternalLink } from "lucide-react";
import {
  useExpenseAttachments,
  type ExpenseAttachment,
} from "@/hooks/useExpenseAttachments";
import { normalizeError } from "@/services/resilience";

const VALID_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 10 * 1024 * 1024;

interface ExpenseReceiptsProps {
  expenseId: string;
  disabled?: boolean;
}

export function ExpenseReceipts({ expenseId, disabled = false }: ExpenseReceiptsProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const {
    attachments,
    isLoading,
    uploadReceipt,
    isUploading,
    removeReceipt,
  } = useExpenseAttachments(expenseId);

  const handleSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!VALID_TYPES.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Upload an image (JPG, PNG, WebP) or a PDF.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast({
        title: "File too large",
        description: "Maximum file size is 10MB.",
        variant: "destructive",
      });
      return;
    }

    try {
      await uploadReceipt(file);
      toast({ title: "Receipt attached" });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  const handleRemove = async (attachment: ExpenseAttachment) => {
    setRemovingId(attachment.id);
    try {
      await removeReceipt(attachment);
      toast({ title: "Receipt removed" });
    } catch (err) {
      toast({
        title: "Could not remove receipt",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading receipts…</p>
      ) : attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No receipts attached yet.</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-3 rounded-md border border-border bg-card p-2"
            >
              <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {attachment.file_name ?? "Receipt"}
              </span>
              <Button asChild variant="ghost" size="sm">
                <a href={attachment.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  <span className="sr-only">Open receipt</span>
                </a>
              </Button>
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(attachment)}
                  disabled={removingId === attachment.id}
                >
                  {removingId === attachment.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  <span className="sr-only">Remove receipt</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            onChange={handleSelect}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Attach receipt
          </Button>
        </>
      )}
    </div>
  );
}
