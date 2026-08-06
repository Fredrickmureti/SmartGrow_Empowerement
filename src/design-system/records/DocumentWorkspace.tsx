/**
 * DocumentWorkspace — one renderer, two presentations.
 *
 * Both the full-page object view and the drawer peek are built from these
 * two pieces. Neither `RecordScaffold` nor `PeekScaffold` may render
 * document content of its own: they choose the *frame* (shell + header +
 * footer, or sheet), and hand the descriptor here for the content. That is
 * what makes peek/full parity structural rather than a convention someone
 * has to remember.
 */
import { SummaryPanel } from "@/design-system";
import { RecordBody } from "./RecordBody";
import { DocumentActivityPanel, DocumentTotalsPanel } from "./panels";
import type { DocumentActivityEntry } from "./panels";
import { DocumentLifecycleStrip } from "./DocumentLifecycleStrip";
import { buildTotalsRows } from "./money";
import { DocumentStatusBadge } from "./documentStatus";
import { useDocumentActivity } from "./useDocumentActivity";
import type { DocumentRecordView } from "./types";
import type { DocumentKind } from "./documentStatus";

/** Format money in the document's currency, falling back to plain digits. */
function formatterFor(currency?: string | null) {
  return (value: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: currency ? "currency" : "decimal",
        currency: currency ?? undefined,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return value.toFixed(2);
    }
  };
}

/** Resolve the totals ladder: explicit rows win, otherwise derive from money. */
export function resolveTotalsRows(view: DocumentRecordView) {
  if (view.totalsRows) return view.totalsRows;
  if (!view.money) return undefined;
  return buildTotalsRows(view.money, {
    format: formatterFor(view.money.currency),
    balanceLabel: view.balanceLabel,
  });
}

/** Status rendering — registry badge unless the document supplies its own. */
export function DocumentStatusSlot({ view }: { view: DocumentRecordView }) {
  if (view.statusSlot) return <>{view.statusSlot}</>;
  if (!view.status) return null;
  return <DocumentStatusBadge kind={view.kind} status={view.status} />;
}

export function DocumentWorkspaceBody({
  view,
  dense,
}: {
  view: DocumentRecordView;
  dense?: boolean;
}) {
  return (
    <>
      {view.lifecycle && (
        <>
          <DocumentLifecycleStrip
            docType={view.lifecycle.docType}
            docId={view.lifecycle.docId}
            dense={dense}
            className={dense ? "mb-2" : "mb-2"}
          />
          <DocumentSettlementStrip
            docType={view.lifecycle.docType}
            docId={view.lifecycle.docId}
            dense={dense}
            className={dense ? "mb-4" : "mb-6"}
          />
        </>
      )}

      <RecordBody
        detailFields={view.detailFields}
        detailsTitle={view.detailsTitle}
        lineColumns={view.lineColumns}
        lineRows={view.lineRows}
        lineEmpty={view.lineEmpty}
        extraSections={view.extraSections}
      />
    </>
  );
}

/**
 * Audit-backed feed. Rendered whenever the descriptor carries a row id and
 * does not override `activity`, so no feature module has to remember to wire
 * history — supplying the id is enough.
 */
function AuditActivityPanel({
  kind,
  documentId,
  extra,
}: {
  kind: DocumentKind;
  documentId: string;
  extra?: DocumentActivityEntry[];
}) {
  const { entries, loading } = useDocumentActivity(kind, documentId);
  return (
    <DocumentActivityPanel
      entries={extra?.length ? [...extra, ...entries] : entries}
      empty={loading ? "Loading activity…" : "No recorded activity yet."}
    />
  );
}

export function DocumentWorkspaceAside({ view }: { view: DocumentRecordView }) {
  const totals = resolveTotalsRows(view);
  if (!hasAside(view)) return null;
  return (
    <SummaryPanel>
      {totals && <DocumentTotalsPanel rows={totals} footer={view.totalsFooter} />}
      {view.activity ? (
        <DocumentActivityPanel entries={view.activity} />
      ) : view.documentId ? (
        <AuditActivityPanel
          kind={view.kind}
          documentId={view.documentId}
          extra={view.activityExtra}
        />
      ) : null}
      {view.extraAside}
    </SummaryPanel>
  );
}

export function hasAside(view: DocumentRecordView) {
  return !!(
    resolveTotalsRows(view) ||
    view.activity ||
    view.documentId ||
    view.extraAside
  );
}
