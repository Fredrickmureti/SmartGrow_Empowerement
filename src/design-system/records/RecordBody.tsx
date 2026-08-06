/**
 * RecordBody — the shared inner section stack used by both the
 * full-page RecordShell (RecordScaffold) and the peek DetailSheet
 * (PeekScaffold). Keeps peek/full parity guaranteed.
 */
import type { ReactNode } from "react";
import { Section } from "@/design-system";
import {
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "./LineItemsGrid";

export interface DetailField {
  label: ReactNode;
  value: ReactNode;
}

interface RecordBodyProps {
  detailFields?: DetailField[];
  detailsTitle?: string;
  lineColumns?: LineItemColumn[];
  lineRows?: LineItemRow[];
  lineEmpty?: ReactNode;
  extraSections?: ReactNode;
}

export function RecordBody({
  detailFields,
  detailsTitle = "Details",
  lineColumns,
  lineRows,
  lineEmpty = "No line items on this record.",
  extraSections,
}: RecordBodyProps) {
  return (
    <>
      {detailFields && detailFields.length > 0 && (
        <Section title={detailsTitle}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {detailFields.map((f, i) => (
              <div key={i}>
                <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                <dd className="mt-0.5">{f.value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {lineColumns && lineRows && (
        <Section title="Line items">
          {lineRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{lineEmpty}</p>
          ) : (
            <LineItemsGrid columns={lineColumns} rows={lineRows} readOnly />
          )}
        </Section>
      )}

      {extraSections}
    </>
  );
}
