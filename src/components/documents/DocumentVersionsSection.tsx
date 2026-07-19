/**
 * DocumentVersionsSection — one-line drop-in for peek sheets and record
 * pages that want to expose the read-only artifact version history for a
 * document (ADR-0084 Wave B3.4).
 *
 * Resolves the active business via `useBusinesses` and self-hides when
 * no artifacts exist, so pages can mount it unconditionally without
 * cluttering documents that have never been rendered.
 */
import { useEffect, useState } from "react";
import { Section } from "@/design-system";
import { useBusinesses } from "@/contexts/BusinessContext";
import { documentArtifactStore } from "@/services/documents/DocumentArtifactStore";
import { DocumentHistoryPanel } from "./DocumentHistoryPanel";

interface DocumentVersionsSectionProps {
  documentType: string;
  documentId: string | null | undefined;
  /** Section title. Defaults to "Version history". */
  title?: string;
  /** Hide the section entirely when there are no artifacts (default true). */
  hideWhenEmpty?: boolean;
}

export function DocumentVersionsSection({
  documentType,
  documentId,
  title = "Version history",
  hideWhenEmpty = true,
}: DocumentVersionsSectionProps) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;
  const [hasArtifacts, setHasArtifacts] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!businessId || !documentId) {
      setHasArtifacts(false);
      return;
    }
    if (!hideWhenEmpty) {
      setHasArtifacts(true);
      return;
    }
    documentArtifactStore
      .list({ businessId, documentType, documentId })
      .then((rows) => {
        if (!cancelled) setHasArtifacts(rows.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasArtifacts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, documentType, documentId, hideWhenEmpty]);

  if (!businessId || !documentId) return null;
  if (hideWhenEmpty && hasArtifacts === false) return null;
  if (hasArtifacts === null) return null;

  return (
    <Section title={title}>
      <DocumentHistoryPanel
        businessId={businessId}
        documentType={documentType}
        documentId={documentId}
      />
    </Section>
  );
}
