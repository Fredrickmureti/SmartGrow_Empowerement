/**
 * DocumentPreviewProvider — the ONE app-wide document preview surface.
 *
 * Enterprise ERPs (SAP, NetSuite, Odoo) separate three verbs that this
 * codebase had collapsed into one button:
 *
 *   - Preview  — read-only render. No ledger row, no dispatch, no paper.
 *   - Print    — policy-driven dispatch to a bound device.
 *   - Download — artifact distribution.
 *
 * This provider owns Preview. Any screen calls `preview({...})` and gets
 * the shared `PrintPreviewDialog` (which renders through
 * `renderDocumentPreview`, a render-only call) instead of mounting its
 * own dialog state or — worse — calling the print pipeline.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import type { DocumentCommunicationContext } from "@/components/communications/DocumentCommunicationBar";

export interface DocumentPreviewRequest {
  /** Legacy source-pair document type, e.g. "invoice", "receipt". */
  documentType: string;
  documentId: string;
  title: string;
  filename?: string;
  communication?: DocumentCommunicationContext;
}

interface DocumentPreviewApi {
  preview: (request: DocumentPreviewRequest) => void;
  close: () => void;
}

const Ctx = createContext<DocumentPreviewApi | null>(null);

export function DocumentPreviewProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DocumentPreviewRequest | null>(null);
  const [open, setOpen] = useState(false);

  const preview = useCallback((next: DocumentPreviewRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const api = useMemo<DocumentPreviewApi>(() => ({ preview, close }), [preview, close]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {request ? (
        <PrintPreviewDialog
          open={open}
          onOpenChange={setOpen}
          title={request.title}
          filename={request.filename ?? request.documentType}
          documentType={request.documentType}
          documentId={request.documentId}
          communication={request.communication}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/**
 * Preview a document without any print side-effect. Safe to call from a
 * "View" affordance — it never enqueues a job or writes to the ledger.
 */
export function useDocumentPreview(): DocumentPreviewApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useDocumentPreview must be used inside <DocumentPreviewProvider>");
  }
  return ctx;
}

export default DocumentPreviewProvider;
