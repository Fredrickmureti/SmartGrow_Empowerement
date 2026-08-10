/**
 * useDocumentEmail — the shared "Send via email" leg of a Purchases
 * document's action vocabulary. Mirrors
 * src/features/sales/record/useDocumentEmail.tsx.
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
