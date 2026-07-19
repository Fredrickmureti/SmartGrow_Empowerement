/**
 * DocumentHistoryPanel — read-only version history for a document.
 *
 * ADR-0084 Wave B3.4. Consumes `documentArtifactStore` to list every
 * rendered version of a (documentType, documentId) pair. Never renders
 * a new artifact — the "Reprint" button re-serves the stored bytes via
 * a short-lived signed URL. To produce a NEW version, callers use
 * `printClient.print()` on the parent page.
 *
 * Empty state is fine: it just means the document has never been
 * rendered through `generate-document` yet (older records rendered
 * before Wave B3 landed will not appear here).
 */

import { useEffect, useState } from "react";
import {
  documentArtifactStore,
  type DocumentArtifact,
} from "@/services/documents/DocumentArtifactStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, Download, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface DocumentHistoryPanelProps {
  businessId: string;
  documentType: string;
  documentId: string;
  /** Optional heading shown above the list. */
  title?: string;
  /** Empty state override. */
  emptyLabel?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function DocumentHistoryPanel({
  businessId,
  documentType,
  documentId,
  title = "Version history",
  emptyLabel = "No rendered versions yet.",
}: DocumentHistoryPanelProps) {
  const [artifacts, setArtifacts] = useState<DocumentArtifact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    documentArtifactStore
      .list({ businessId, documentType, documentId })
      .then((rows) => {
        if (!cancelled) setArtifacts(rows);
      })
      .catch((err) => {
        console.error("[DocumentHistoryPanel] list failed:", err);
        if (!cancelled) setArtifacts([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, documentType, documentId]);

  const open = async (artifact: DocumentArtifact, download: boolean) => {
    setOpeningId(artifact.id);
    try {
      const url = await documentArtifactStore.signedUrl(artifact);
      if (download) {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${artifact.document_number ?? documentType}-v${artifact.version}.${
          artifact.mime_type === "application/pdf" ? "pdf" : "bin"
        }`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      toast.error("Could not open artifact", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {artifacts && artifacts.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {artifacts.length} version{artifacts.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : artifacts && artifacts.length > 0 ? (
        <ScrollArea className="max-h-64 rounded-md border">
          <ul className="divide-y">
            {artifacts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">v{a.version}</span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {a.render_mode}
                    </Badge>
                    {a.intent && a.intent !== "original" && (
                      <Badge variant="secondary" className="text-[10px]">
                        {a.intent}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {new Date(a.created_at).toLocaleString()} · {formatBytes(a.byte_size)}
                    {a.regeneration_reason ? ` · ${a.regeneration_reason}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => open(a, false)}
                    disabled={openingId === a.id}
                    title="Open"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => open(a, true)}
                    disabled={openingId === a.id}
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : (
        <div className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
