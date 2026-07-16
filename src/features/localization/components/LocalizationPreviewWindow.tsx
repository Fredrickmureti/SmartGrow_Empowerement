/**
 * LocalizationPreviewWindow — the entire body rendered inside the
 * pop-out preview browser window opened from AuthoringWorkspace.
 *
 * Subscribes to `previewBroadcast` for the given (kind, templateCode)
 * and swaps to the matching preview pane. No editing surface, no
 * chrome — just the paged document / return PDF the publisher would
 * see in the split layout.
 */
import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { CertificatePreviewPane } from "./CertificatePreviewPane";
import { ReturnPreviewPane } from "./ReturnPreviewPane";
import {
  readPreview,
  subscribePreview,
  type PreviewKind,
  type PreviewPayload,
} from "../lib/previewBroadcast";

interface Props {
  kind: string;
  templateCode: string;
}

function isValidKind(k: string): k is PreviewKind {
  return k === "certificate" || k === "return";
}

export function LocalizationPreviewWindow({ kind, templateCode }: Props) {
  const validKind = isValidKind(kind) ? kind : null;
  const [payload, setPayload] = useState<PreviewPayload | null>(() =>
    validKind ? readPreview(validKind, templateCode) : null,
  );

  useEffect(() => {
    if (!validKind) return;
    // Re-read on mount (handles the race where the parent broadcast
    // fires before we subscribe).
    setPayload(readPreview(validKind, templateCode));
    const stop = subscribePreview(validKind, templateCode, (next) => setPayload(next));
    // Also set the tab title so a publisher with several pop-outs can tell them apart.
    try { document.title = `${templateCode} — preview`; } catch { /* ignore */ }
    return stop;
  }, [validKind, templateCode]);

  if (!validKind) {
    return (
      <EmptyState message={`Unknown preview kind "${kind}". Expected "certificate" or "return".`} />
    );
  }
  if (!payload) {
    return (
      <EmptyState message="Waiting for the editor window to broadcast the current draft…" />
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-muted/20 p-4">
      <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-lg border bg-background shadow-sm">
        {validKind === "certificate" ? (
          <CertificatePreviewPane
            templateCode={payload.templateCode}
            displayName={payload.displayName ?? payload.templateCode}
            body={payload.body}
            meta={payload.meta as any}
          />
        ) : (
          <ReturnPreviewPane
            templateCode={payload.templateCode}
            displayName={payload.displayName ?? payload.templateCode}
            body={payload.body}
            meta={payload.meta as any}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-muted/20 p-8 text-center text-sm text-muted-foreground">
      <div className="flex max-w-md flex-col items-center gap-3">
        <AlertCircle className="h-6 w-6 text-muted-foreground/60" />
        <p>{message}</p>
      </div>
    </div>
  );
}

export default LocalizationPreviewWindow;