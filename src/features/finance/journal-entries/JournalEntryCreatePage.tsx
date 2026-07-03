/**
 * JournalEntryCreatePage — routed create surface at
 * `/finance/journal-entries/new`. Composes `JournalEntryForm` on
 * `RecordFormShell`. Replaces the legacy inline dialog previously
 * mounted from `src/pages/JournalEntries.tsx`.
 */
import { JournalEntryForm } from "./JournalEntryForm";

export default function JournalEntryCreatePage() {
  return <JournalEntryForm mode="create" />;
}