/**
 * OversellConfirmation — the one oversell acknowledgement UI for Sales.
 *
 * Rendered by every `commit`-policy document (invoice, sales order, delivery
 * note). It lists exactly which lines are short and requires a deliberate tick
 * before the document can be saved, so overselling is always a recorded
 * decision rather than an accident. Advisory documents (estimate, proforma)
 * never render it — see `salesStockPolicy.ts`.
 */
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  SALES_DOCUMENT_LABEL,
  type SalesDocumentKind,
} from "./salesStockPolicy";
import type { SalesLineAvailability } from "./useSalesLineAvailability";

interface Props {
  kind: SalesDocumentKind;
  availability: SalesLineAvailability;
  disabled?: boolean;
  /** Unique per form when two of these could ever coexist. */
  id?: string;
}

export function OversellConfirmation({
  kind,
  availability,
  disabled,
  id = "confirm-oversell",
}: Props) {
  if (!availability.requiresConfirmation) return null;
  const { oversoldLines, confirmed, setConfirmed } = availability;

  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="space-y-2">
        <div className="font-semibold">
          {oversoldLines.length === 1
            ? "1 line exceeds available stock"
            : `${oversoldLines.length} lines exceed available stock`}
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {oversoldLines.map((line) => (
            <li key={`${line.index}-${line.product.id}`}>
              <strong>{line.product.name}</strong>: {line.result.message}
            </li>
          ))}
        </ul>
        <div className="flex items-start gap-2 pt-2">
          <Checkbox
            id={id}
            checked={confirmed}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
            disabled={disabled}
          />
          <Label
            htmlFor={id}
            className="cursor-pointer text-sm font-normal leading-snug"
          >
            I confirm overselling — proceed with this{" "}
            {SALES_DOCUMENT_LABEL[kind]} even though stock is insufficient.
            Backorder may be required.
          </Label>
        </div>
      </AlertDescription>
    </Alert>
  );
}
