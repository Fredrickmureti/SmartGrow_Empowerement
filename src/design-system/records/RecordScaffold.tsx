/**
 * RecordScaffold — the standard read/view scaffold every Sales
 * business-record page composes. Encapsulates the boilerplate the three
 * pilot pages (Invoice / Estimate / SalesOrder) repeated verbatim so
 * subsequent record types are a thin, data-only wrapper.
 *
 * Pages provide: eyebrow, title/docNumber/status/meta, totals rows,
 * activity entries, details FieldGrid cells, and the LineItemsGrid
 * columns/rows. The scaffold owns the shell layout, header actions,
 * loading/error/isNew rendering, and the sticky FooterActionBar.
 */

import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Printer } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
  SummaryPanel,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  DocumentActivityPanel,
  DocumentTotalsPanel,
  type DocumentActivityEntry,
  type DocumentTotalsRow,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system/records";
import { RecordBody } from "./RecordBody";

import type { DetailField } from "./RecordBody";
export type { DetailField };

interface RecordScaffoldProps {
  /** e.g. "Sales Invoice", "Delivery Note". */
  eyebrow: string;
  /** Back-to-list route (e.g. "/sales/credit-notes"). */
  listPath: string;
  /** Route id (":id" param). "new" renders the create placeholder. */
  id: string;
  /** Loading flag. */
  loading?: boolean;
  /** Fatal error message; when present renders ErrorState. */
  error?: string | null;
  /** True when the record was not found. */
  notFound?: boolean;

  // Header
  title: ReactNode;
  docNumber?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  /** Override the default Back/Print/Edit action cluster. */
  headerActions?: ReactNode;
  /** Called by the default Edit action; disabled if not supplied. */
  onEdit?: () => void;
  /** Called by the default Print action; disabled if not supplied. */
  onPrint?: () => void;

  // Body
  detailFields?: DetailField[];
  detailsTitle?: string;
  lineColumns?: LineItemColumn[];
  lineRows?: LineItemRow[];
  lineEmpty?: ReactNode;
  /** Extra sections rendered after the line-items grid. */
  extraSections?: ReactNode;

  // Aside
  totalsRows?: DocumentTotalsRow[];
  totalsFooter?: ReactNode;
  activity?: DocumentActivityEntry[];
  extraAside?: ReactNode;

  /** Copy for the "new" placeholder. */
  newLabel?: string;
  newDescription?: ReactNode;
}

export function RecordScaffold(props: RecordScaffoldProps) {
  const navigate = useNavigate();
  const {
    eyebrow,
    listPath,
    id,
    loading,
    error,
    notFound,
    title,
    docNumber,
    status,
    meta,
    headerActions,
    onEdit,
    onPrint,
    detailFields,
    detailsTitle = "Details",
    lineColumns,
    lineRows,
    lineEmpty = "No line items on this record.",
    extraSections,
    totalsRows,
    totalsFooter,
    activity,
    extraAside,
    newLabel = "New record",
    newDescription,
  } = props;

  const isNew = id === "new";

  if (isNew) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow={eyebrow}
            title={newLabel}
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={() => navigate(listPath)}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back to list
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section title="Create flow pending migration">
          <p className="text-sm text-muted-foreground">
            {newDescription ?? (
              <>
                The create wizard for this record is scheduled next in the Sales
                record migration. Use the <strong>New</strong> action on the{" "}
                <Link className="underline" to={listPath}>
                  list page
                </Link>{" "}
                for now.
              </>
            )}
          </p>
        </Section>
      </RecordShell>
    );
  }

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow={eyebrow} title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || notFound) {
    return (
      <RecordShell header={<RecordHeader eyebrow={eyebrow} title={eyebrow} />}>
        <Section>
          <ErrorState
            title={notFound ? "Record not found" : "Unable to load record"}
            description={error ?? "The record you're looking for no longer exists or you don't have access."}
            onRetry={() => navigate(listPath)}
          />
        </Section>
      </RecordShell>
    );
  }

  const defaultActions = (
    <ActionBar>
      <Button variant="outline" size="sm" onClick={() => navigate(listPath)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onPrint}
        disabled={!onPrint}
        title={onPrint ? undefined : "Print will land with the edit wizard migration"}
      >
        <Printer className="mr-2 h-4 w-4" /> Print
      </Button>
      <Button
        size="sm"
        onClick={onEdit}
        disabled={!onEdit}
        title={onEdit ? undefined : "Editing still uses the list dialog while migration is in progress"}
      >
        <Pencil className="mr-2 h-4 w-4" /> Edit
      </Button>
    </ActionBar>
  );

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow={eyebrow}
          title={title}
          docNumber={docNumber}
          status={status}
          meta={meta}
          actions={headerActions ?? defaultActions}
        />
      }
      aside={
        totalsRows || activity || extraAside ? (
          <SummaryPanel>
            {totalsRows && <DocumentTotalsPanel rows={totalsRows} footer={totalsFooter} />}
            {activity && <DocumentActivityPanel entries={activity} />}
            {extraAside}
          </SummaryPanel>
        ) : undefined
      }
      footer={
        <FooterActionBar
          trailing={
            <Button variant="outline" onClick={() => navigate(listPath)}>
              Close
            </Button>
          }
        />
      }
    >
      <RecordBody
        detailFields={detailFields}
        detailsTitle={detailsTitle}
        lineColumns={lineColumns}
        lineRows={lineRows}
        lineEmpty={lineEmpty}
        extraSections={extraSections}
      />
    </RecordShell>
  );
}

export default RecordScaffold;