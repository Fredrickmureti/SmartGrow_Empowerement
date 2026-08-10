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
import { ArrowLeft, FileSearch, Pencil, Printer } from "lucide-react";

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
import { DocumentActionsBar } from "./DocumentActions";
import type { DocumentAction } from "./DocumentActions";
import type { DocumentRecordView } from "./types";

import type { DetailField } from "./RecordBody";
export type { DetailField };

interface RecordScaffoldProps extends DocumentRecordView {
  /** Route id (":id" param). "new" renders the create placeholder. */
  id: string;
  /**
   * The document's action vocabulary — the same array the list row menu
   * renders. Preferred over `headerActions`; when supplied it replaces the
   * default Back/Print/Edit cluster (Back is re-added automatically).
   */
  actions?: DocumentAction[];
  /** Escape hatch for hand-rolled clusters. Prefer `actions`. */
  headerActions?: ReactNode;
  /** Called by the default Edit action; disabled if not supplied. */
  onEdit?: () => void;
  /** Called by the default Print action; disabled if not supplied. */
  onPrint?: () => void;
  /** Called by the default Preview action; hidden if not supplied. */
  onPreview?: () => void;
  /** Extra footer content rendered next to Close (e.g. action dialogs). */
  footerLeading?: ReactNode;
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
    actions,
    headerActions,
    footerLeading,
    onEdit,
    onPrint,
    onPreview,
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
      {onPreview ? (
        <Button variant="outline" size="sm" onClick={onPreview}>
          <FileSearch className="mr-2 h-4 w-4" /> Preview
        </Button>
      ) : null}
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

  const actionCluster = actions?.length ? (
    <ActionBar>
      <Button variant="outline" size="sm" onClick={() => navigate(listPath)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>
      <DocumentActionsBar actions={actions} />
    </ActionBar>
  ) : null;

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow={eyebrow}
          title={title}
          docNumber={docNumber}
          status={<DocumentStatusSlot view={props} />}
          meta={meta}
          actions={actionCluster ?? headerActions ?? defaultActions}
        />
      }
      aside={hasAside(props) ? <DocumentWorkspaceAside view={props} /> : undefined}
      footer={
        <FooterActionBar
          leading={footerLeading}
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
