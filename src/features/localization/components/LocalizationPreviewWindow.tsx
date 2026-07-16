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
import {
  readPreview,
  subscribePreview,
  type PreviewKind,
  type PreviewPayload,
} from "../lib/previewBroadcast";
import { resolvePopOutRenderer } from "../lib/preview/rendererRegistry";


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