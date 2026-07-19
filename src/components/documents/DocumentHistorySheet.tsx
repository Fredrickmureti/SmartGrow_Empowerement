/**
 * DocumentHistorySheet — reusable sheet exposing DocumentVersionsSection
 * for any (documentType, documentId) pair, so list rows can surface the
 * artifact version history without a dedicated record page (ADR-0084).
 */
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { History } from "lucide-react";
import { useState } from "react";
import { DocumentVersionsSection } from "./DocumentVersionsSection";

interface Props {
  documentType: string;
  documentId: string | null | undefined;
  title?: string;
  description?: string;
  triggerLabel?: string;
}

export function DocumentHistorySheet({
  documentType,
  documentId,
  title = "Version history",
  description = "Immutable rendered artifacts for this document.",
  triggerLabel = "History",
}: Props) {
  const [open, setOpen] = useState(false);
  if (!documentId) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="Document history"
      >
        <History className="mr-1 h-3.5 w-3.5" />
        {triggerLabel}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <DocumentVersionsSection
              documentType={documentType}
              documentId={documentId}
              hideWhenEmpty={false}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
