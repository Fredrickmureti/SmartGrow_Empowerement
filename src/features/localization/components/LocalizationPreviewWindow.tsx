/**
 * LocalizationPreviewWindow — the entire body rendered inside the
 * pop-out preview browser window opened from AuthoringWorkspace.
 *
 * Subscribes to `previewBroadcast` for the given (kind, templateCode)
 * and delegates rendering to the shared `resolvePopOutRenderer`
 * registry so the pop-out and the in-workspace preview cannot drift.
 */
import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  readPreview,
  subscribePreview,
  type PreviewKind,
  type PreviewPayload,
} from "../lib/previewBroadcast";
import { resolvePopOutRenderer } from "../lib/preview/rendererRegistry";

interface Props {
  kind: string;
  templateCode: string;
}

const VALID_KINDS: PreviewKind[] = [
  "certificate",
  "return",
  "bank-export",
  "garnishment",
  "token-registry",
  "statutory-authority",
  "pack-requirements",
  "publisher-governance",
];

function isValidKind(k: string): k is PreviewKind {
  return (VALID_KINDS as string[]).includes(k);
}

export function LocalizationPreviewWindow({ kind, templateCode }: Props) {
  const validKind = isValidKind(kind) ? kind : null;
  const [payload, setPayload] = useState<PreviewPayload | null>(() =>
    validKind ? readPreview(validKind, templateCode) : null,
  );

  useEffect(() => {
    if (!validKind) return;
    setPayload(readPreview(validKind, templateCode));
    const stop = subscribePreview(validKind, templateCode, (next) => setPayload(next));
    try { document.title = `${templateCode} — preview`; } catch { /* ignore */ }
    return stop;
  }, [validKind, templateCode]);

  if (!validKind) {
    return <EmptyState message={`Unknown preview kind "${kind}".`} />;
  }
  if (!payload) {
    return <EmptyState message="Waiting for the editor window to broadcast the current draft…" />;
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-muted/20 p-4">
      <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-lg border bg-background shadow-sm">
        {resolvePopOutRenderer(validKind, payload)}
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
