/**
 * useDocumentEmail — the shared "Send via email" leg of a document's action
 * vocabulary. Every `use<Doc>Actions` hook composes this instead of
 * re-declaring the SendDocumentDialog wiring.
 */
import { useCallback, useState } from "react";

import {
  SendDocumentDialog,
  type DocumentEmailData,
} from "@/components/common/SendDocumentDialog";

export function useDocumentEmail(onSent?: () => void) {
  const [document, setDocument] = useState<DocumentEmailData | null>(null);
  const [open, setOpen] = useState(false);

  const send = useCallback((doc: DocumentEmailData) => {
    setDocument(doc);
    setOpen(true);
  }, []);

  const dialog = (
    <SendDocumentDialog
      open={open}
      onOpenChange={setOpen}
      document={document}
      onSuccess={() => onSent?.()}
    />
  );

  return { send, dialog };
}
