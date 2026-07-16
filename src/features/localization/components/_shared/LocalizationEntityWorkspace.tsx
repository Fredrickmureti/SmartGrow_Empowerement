/**
 * LocalizationEntityWorkspace — thin adapter that wraps an editor's
 * existing form/list content inside the shared `AuthoringWorkspace`
 * shell, wires the pop-out broadcast, and mounts a preview pane on
 * the right so every localization editor gets the same enterprise
 * layout without each one re-implementing the plumbing.
 *
 * The parent editor still owns:
 *   - the query / mutation lifecycle
 *   - the actual authoring UI (rendered as the `editor` slot)
 *   - the shape of the preview payload (a `SpreadsheetPreviewProps`
 *     or `EntityInspectorPaneProps` object)
 *
 * This wrapper only handles:
 *   - preview broadcast so the pop-out route paints identically
 *   - the "open in new window" handler
 *   - fill-parent height + overlay layout defaults
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { AuthoringWorkspace } from "@/design-system/primitives/AuthoringWorkspace";
import { SpreadsheetPreviewPane, type SpreadsheetPreviewProps } from "../preview/SpreadsheetPreviewPane";
import { EntityInspectorPane, type EntityInspectorPaneProps } from "../preview/EntityInspectorPane";
import { openPreviewWindow, publishPreview, type PreviewKind } from "../../lib/previewBroadcast";

type PreviewSpec =
  | { pane: "spreadsheet"; props: SpreadsheetPreviewProps }
  | { pane: "inspector"; props: EntityInspectorPaneProps };

interface Props {
  workspaceId: string;
  kind: PreviewKind;
  templateCode: string;
  displayName?: string;
  preview: PreviewSpec;
  toolbar?: ReactNode;
  rail?: ReactNode;
  editor: ReactNode;
  statusBar?: ReactNode;
  footer?: ReactNode;
  onSave?: () => void;
  className?: string;
}

export function LocalizationEntityWorkspace({
  workspaceId,
  kind,
  templateCode,
  displayName,
  preview,
  toolbar,
  rail,
  editor,
  statusBar,
  footer,
  onSave,
  className,
}: Props) {
  // Broadcast the current preview props so the pop-out window paints
  // the exact same pane. Payload is JSON-safe: SpreadsheetPreviewProps /
  // EntityInspectorPaneProps contain plain values + React nodes are
  // avoided in the pieces the pop-out consumes (see the panes' contract).
  useEffect(() => {
    publishPreview({
      kind,
      templateCode,
      body: preview.props as unknown,
      meta: null,
      displayName: displayName ?? null,
      updatedAt: Date.now(),
    });
  }, [kind, templateCode, displayName, preview]);

  const previewNode = useMemo(() => {
    if (preview.pane === "spreadsheet") return <SpreadsheetPreviewPane {...preview.props} />;
    return <EntityInspectorPane {...preview.props} />;
  }, [preview]);

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col bg-background ${className ?? ""}`}>
      <AuthoringWorkspace
        workspaceId={workspaceId}
        toolbar={toolbar}
        rail={rail}
        editor={editor}
        preview={previewNode}
        statusBar={statusBar}
        footer={footer}
        defaultMode="overlay"
        onSave={onSave}
        onPopOutPreview={() => openPreviewWindow(kind, templateCode)}
      />
    </div>
  );
}

export default LocalizationEntityWorkspace;