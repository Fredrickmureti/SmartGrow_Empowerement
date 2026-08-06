/**
 * PeekScaffold — the drawer projection of a `DocumentRecordView`.
 *
 * Same descriptor as the full page, same body renderer; only the frame
 * differs. The peek stacks the summary beneath the body instead of placing
 * it in a rail, and marks the lifecycle strip dense.
 */

import type { ReactNode } from "react";
import { DocumentPeekShell } from "./DocumentPeekShell";
import {
  DocumentStatusSlot,
  DocumentWorkspaceAside,
  DocumentWorkspaceBody,
  hasAside,
} from "./DocumentWorkspace";
import type { DocumentRecordView } from "./types";

interface PeekScaffoldProps extends DocumentRecordView {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description?: ReactNode;
  fullPageHref?: string;
  extraHeaderActions?: ReactNode;
}

export function PeekScaffold(props: PeekScaffoldProps) {
  const {
    open,
    onOpenChange,
    title,
    docNumber,
    description,
    fullPageHref,
    extraHeaderActions,
    loading,
    error,
  } = props;

  return (
    <DocumentPeekShell
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          <DocumentStatusSlot view={props} />
        </span>
      }
      description={description ?? docNumber}
      fullPageHref={fullPageHref}
      extraHeaderActions={extraHeaderActions}
      loading={loading}
      error={error}
    >
      <div className="space-y-6">
        <DocumentWorkspaceBody view={props} dense />
        {hasAside(props) && <DocumentWorkspaceAside view={props} />}
      </div>
    </DocumentPeekShell>
  );
}

export default PeekScaffold;
