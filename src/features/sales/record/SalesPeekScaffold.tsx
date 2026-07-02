/**
 * SalesPeekScaffold — the ONE peek surface every Sales list uses. Mirrors
 * SalesRecordScaffold's data shape (details, totals, activity, line items)
 * so the peek and the full record page cannot drift. Consumers pass the
 * same declaration and the scaffold renders inside DocumentPeekShell.
 */

import type { ReactNode } from "react";
import { SummaryPanel } from "@/design-system";
import { DocumentPeekShell } from "./DocumentPeekShell";
import { SalesRecordBody, type DetailField } from "./SalesRecordBody";
import {
  DocumentActivityPanel,
  DocumentTotalsPanel,
  type DocumentActivityEntry,
  type DocumentTotalsRow,
} from "./panels";
import type { LineItemColumn, LineItemRow } from "./LineItemsGrid";

interface SalesPeekScaffoldProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  title: ReactNode;
  description?: ReactNode;
  fullPageHref?: string;
  extraHeaderActions?: ReactNode;

  loading?: boolean;
  error?: string | null;

  detailFields?: DetailField[];
  detailsTitle?: string;
  lineColumns?: LineItemColumn[];
  lineRows?: LineItemRow[];
  lineEmpty?: ReactNode;
  extraSections?: ReactNode;

  totalsRows?: DocumentTotalsRow[];
  totalsFooter?: ReactNode;
  activity?: DocumentActivityEntry[];
  extraAside?: ReactNode;
}

export function SalesPeekScaffold({
  open,
  onOpenChange,
  title,
  description,
  fullPageHref,
  extraHeaderActions,
  loading,
  error,
  detailFields,
  detailsTitle,
  lineColumns,
  lineRows,
  lineEmpty,
  extraSections,
  totalsRows,
  totalsFooter,
  activity,
  extraAside,
}: SalesPeekScaffoldProps) {
  const hasAside = !!(totalsRows || activity || extraAside);
  return (
    <DocumentPeekShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      fullPageHref={fullPageHref}
      extraHeaderActions={extraHeaderActions}
      loading={loading}
      error={error}
    >
      <div className="space-y-6">
        <SalesRecordBody
          detailFields={detailFields}
          detailsTitle={detailsTitle}
          lineColumns={lineColumns}
          lineRows={lineRows}
          lineEmpty={lineEmpty}
          extraSections={extraSections}
        />
        {hasAside && (
          <SummaryPanel>
            {totalsRows && <DocumentTotalsPanel rows={totalsRows} footer={totalsFooter} />}
            {activity && <DocumentActivityPanel entries={activity} />}
            {extraAside}
          </SummaryPanel>
        )}
      </div>
    </DocumentPeekShell>
  );
}

export default SalesPeekScaffold;
