/**
 * JournalEntryPeekSheet — `?peek=<id>` peek surface for the Journal
 * Entries list. Renders on `PeekScaffold` with "Open full page" pointing
 * to `/finance/journal-entries/:id`.
 */
import { useMemo } from "react";
import { PeekScaffold } from "@/design-system";
import { DocumentActionsMenu } from "@/design-system/records";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { useCurrency } from "@/hooks/useCurrency";
import { buildJournalEntryView } from "./journalEntryView";
import { useJournalEntryActions } from "./useJournalEntryActions";

interface JournalEntryPeekSheetProps {
  entryId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function JournalEntryPeekSheet({
  entryId,
  onOpenChange,
}: JournalEntryPeekSheetProps) {
  const { journalEntries, isLoading } = useJournalEntries();
  const { formatCurrency } = useCurrency();

  const entry = useMemo(
    () => (entryId ? journalEntries.find((e) => e.id === entryId) : undefined),
    [journalEntries, entryId],
  );

  const view = useMemo(
    () =>
      entry
        ? buildJournalEntryView(entry, {
            formatCurrency,
            findEntry: (id) => journalEntries.find((e) => e.id === id),
          })
        : null,
    [entry, journalEntries, formatCurrency],
  );

  const open = !!entryId;
  const notFound = !isLoading && !!entryId && !entry;
  const actions = useJournalEntryActions(entry);

  return (
    <PeekScaffold
      kind="generic"
      eyebrow="Journal Entry"
      listPath="/finance/journal-entries"
      open={open}
      onOpenChange={onOpenChange}
      title={view ? `Journal Entry ${view.docNumber}` : "Journal Entry"}
      description={view?.title}
      fullPageHref={entryId ? `/finance/journal-entries/${entryId}` : undefined}
      extraHeaderActions={
        actions.length ? <DocumentActionsMenu actions={actions} /> : undefined
      }
      loading={isLoading && !entry}
      error={notFound ? "This journal entry no longer exists or you don't have access." : null}
      detailFields={view?.detailFields}
      lineColumns={view?.lineColumns}
      lineRows={view?.lineRows}
      lineEmpty="No lines on this entry."
      totalsRows={view?.totalsRows}
      activity={view?.activity}
    />
  );
}

export default JournalEntryPeekSheet;