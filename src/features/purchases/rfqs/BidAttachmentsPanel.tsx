/**
 * Bid attachments panel — shared by the vendor portal (supplier uploading its
 * own evidence) and the buyer-side RFQ record (read-only review).
 *
 * The component owns no lifecycle rules: `canEdit` only hides controls the
 * server would refuse anyway (superseded version, deadline passed, RFQ closed).
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Paperclip, Upload, Download, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import {
  BID_ATTACHMENT_KINDS,
  type BidAttachmentKind,
  bidAttachmentKindLabel,
  bidAttachmentUrl,
  formatFileSize,
  listBidAttachments,
  removeBidAttachment,
  uploadBidAttachment,
} from "./bidAttachments";

interface BidAttachmentsPanelProps {
  rfqId: string;
  quotationId: string;
  canEdit: boolean;
  /** Shown when there is nothing attached and uploading is not possible. */
  emptyLabel?: string;
  className?: string;
}

export function BidAttachmentsPanel({
  rfqId,
  quotationId,
  canEdit,
  emptyLabel = "No supporting documents attached.",
  className,
}: BidAttachmentsPanelProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<BidAttachmentKind>("bid_document");

  const queryKey = ["rfq-bid-attachments", quotationId];
  const { data: attachments = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listBidAttachments(quotationId),
    enabled: !!quotationId,
  });

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await uploadBidAttachment({ rfqId, quotationId, file, kind });
      }
    },
    onSuccess: () => {
      toast.success("Attachment added to your bid");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeBidAttachment(id),
    onSuccess: () => {
      toast.success("Attachment removed");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  const openAttachment = async (path: string) => {
    try {
      window.open(await bidAttachmentUrl(path), "_blank", "noopener");
    } catch (err) {
      toast.error(normalizeError(err).message);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          Supporting documents
          {attachments.length > 0 && (
            <Badge variant="secondary">{attachments.length}</Badge>
          )}
        </p>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as BidAttachmentKind)}>
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BID_ATTACHMENT_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) uploadMutation.mutate(files);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploadMutation.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {uploadMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              Attach file
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading attachments…</p>
        )}
        {!isLoading && attachments.length === 0 && (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        )}
        {attachments.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <button
                type="button"
                className="text-sm font-medium truncate hover:underline text-left"
                onClick={() => openAttachment(a.file_path)}
              >
                {a.file_name}
              </button>
              <p className="text-xs text-muted-foreground">
                {bidAttachmentKindLabel(a.attachment_kind)}
                {a.file_size ? ` · ${formatFileSize(a.file_size)}` : ""}
                {a.carried_forward_from ? " · carried from previous version" : ""}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => openAttachment(a.file_path)}
                aria-label={`Open ${a.file_name}`}
              >
                <Download className="h-4 w-4" />
              </Button>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(a.id)}
                  aria-label={`Remove ${a.file_name}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default BidAttachmentsPanel;
