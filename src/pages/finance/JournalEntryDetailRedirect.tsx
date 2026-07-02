/**
 * JournalEntryDetailRedirect
 *
 * Per-record route `/finance/journal-entries/:id` that deep-links into the
 * existing JournalEntries list page with the detail dialog auto-opened via
 * the `?selected=...` query param. This gives accountants the bookmarkable,
 * shareable, "tab per record" URL that drill-down chains rely on, without
 * rewriting the heavy JE detail logic that already lives in the list page.
 */

import { Navigate, useParams } from "react-router-dom";

export default function JournalEntryDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/finance/journal-entries" replace />;
  return <Navigate to={`/finance/journal-entries?selected=${id}`} replace />;
}
