/**
 * JournalEntryEditPage — routed edit surface at
 * `/finance/journal-entries/:id/edit`. Loads the target entry from
 * `useJournalEntries` and hands it to `JournalEntryForm`. Only draft
 * entries are editable; posted / voided / reversed entries are sent
 * back to the list with a redirect (mirrors the legacy dialog guard).
 */
import { useMemo } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { JournalEntryForm } from "./JournalEntryForm";

export default function JournalEntryEditPage() {
  const { id } = useParams<{ id: string }>();
  const { journalEntries, isLoading } = useJournalEntries();
  const entry = useMemo(
    () => journalEntries.find((e) => e.id === id) || null,
    [journalEntries, id],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!entry) return <Navigate to="/finance/journal-entries" replace />;
  if (entry.status !== "draft") {
    return (
      <Navigate
        to={`/finance/journal-entries?selected=${entry.id}`}
        replace
      />
    );
  }
  return <JournalEntryForm mode="edit" entry={entry} />;
}