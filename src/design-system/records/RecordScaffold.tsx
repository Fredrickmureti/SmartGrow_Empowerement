/**
 * RecordScaffold — the full-page projection of a `DocumentRecordView`.
 *
 * Owns only what a page owns: the shell, the header action cluster, the
 * loading / error / not-found states and the sticky footer. All document
 * content comes from DocumentWorkspace, so the page and the peek render the
 * same body from the same descriptor.
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
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  DocumentStatusSlot,
  DocumentWorkspaceAside,
  DocumentWorkspaceBody,
  hasAside,
} from "./DocumentWorkspace";
import type { DocumentRecordView } from "./types";

import type { DetailField } from "./RecordBody";
export type { DetailField };

interface RecordScaffoldProps extends DocumentRecordView {
  /** Route id (":id" param). "new" renders the create placeholder. */
  id: string;
  /** Override the default Back/Print/Edit action cluster. */
  headerActions?: ReactNode;
  /** Called by the default Edit action; disabled if not supplied. */
  onEdit?: () => void;
  /** Called by the default Print action; disabled if not supplied. */
  onPrint?: () => void;
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
    meta,
    headerActions,
    onEdit,
    onPrint,
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
                The create wizard for this record is scheduled next in the record
                migration. Use the <strong>New</strong> action on the{" "}
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
            description={
              error ??
              "The record you're looking for no longer exists or you don't have access."
            }
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
        title={onPrint ? undefined : "Print is not available for this record"}
      >
        <Printer className="mr-2 h-4 w-4" /> Print
      </Button>
      <Button size="sm" onClick={onEdit} disabled={!onEdit}>
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
          status={<DocumentStatusSlot view={props} />}
          meta={meta}
          actions={headerActions ?? defaultActions}
        />
      }
      aside={hasAside(props) ? <DocumentWorkspaceAside view={props} /> : undefined}
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
      <DocumentWorkspaceBody view={props} />
    </RecordShell>
  );
}

export default RecordScaffold;
