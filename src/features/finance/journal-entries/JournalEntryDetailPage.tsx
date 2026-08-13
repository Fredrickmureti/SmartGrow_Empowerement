/**
 * JournalEntryDetailPage — routed read/view surface at
 * `/finance/journal-entries/:id`. Composes `RecordScaffold` with the
 * shared `journalEntryView` builder so peek and full page cannot drift.
 * Replaces the legacy `JournalEntryDetailRedirect` `?selected=` hop.
 */
import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Pencil } from "lucide-react";
import { RecordScaffold } from "@/design-system";
import type { DocumentAction } from "@/design-system/records";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { useCurrency } from "@/hooks/useCurrency";
import { buildJournalEntryView } from "./journalEntryView";
import { useJournalEntryActions } from "./useJournalEntryActions";

export default function JournalEntryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { journalEntries, isLoading } = useJournalEntries();
  const { formatCurrency } = useCurrency();

  const entry = useMemo(
    () => (id ? journalEntries.find((e) => e.id === id) : undefined),
    [journalEntries, id],
  );

  const view = useMemo(
    () =>
      entry
        ? buildJournalEntryView(entry, {
            formatCurrency,
            findEntry: (rid) => journalEntries.find((e) => e.id === rid),
          })
        : null,
    [entry, journalEntries, formatCurrency],
  );

  const outputActions = useJournalEntryActions(entry);

  if (!id) return <Navigate to="/finance/journal-entries" replace />;

  const notFound = !isLoading && !entry;
  const canEdit = entry?.status === "draft";

  // `actions` replaces the scaffold's default cluster, so Edit travels in
  // the same array as the output verbs.
  const actions: DocumentAction[] = entry
    ? [
        {
          id: "edit",
          label: "Edit",
          icon: Pencil,
          group: "core",
          primary: canEdit,
          disabled: !canEdit,
          disabledReason: canEdit
            ? undefined
            : "Only a draft entry can be edited — post a reversal instead.",
          onSelect: () => navigate(`/finance/journal-entries/${id}/edit`),
        },
        ...outputActions,
      ]
    : [];

  return (
    <RecordScaffold
      eyebrow="Journal Entry"
      listPath="/finance/journal-entries"
      id={id}
      loading={isLoading && !entry}
      notFound={notFound}
      title={view?.title ?? "Journal Entry"}
      docNumber={view?.docNumber}
      kind="generic"
      statusSlot={view?.status}
      meta={view?.meta}
      actions={actions}
      detailFields={view?.detailFields}
      lineColumns={view?.lineColumns}
      lineRows={view?.lineRows}
      lineEmpty="No lines on this entry."
      totalsRows={view?.totalsRows}
      activity={view?.activity}
    />
  );
}