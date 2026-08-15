/**
 * SalesWarehouseField — the single warehouse picker for Sales editors.
 *
 * Renders nothing when the branch has one warehouse or fewer: there is no
 * decision to make, and the server resolves the branch default anyway.
 */
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SalesWarehouseSelection } from "./useSalesWarehouse";

interface Props {
  selection: SalesWarehouseSelection;
  /** Wording differs per document ("Ship from", "Fulfil from"). */
  label?: string;
  disabled?: boolean;
}

export function SalesWarehouseField({
  selection,
  label = "Fulfil from warehouse",
  disabled,
}: Props) {
  if (selection.hidden) return null;

  return (
    <div className="space-y-2">
      <Label htmlFor="sales-warehouse">{label}</Label>
      <Select
        value={selection.warehouseId ?? undefined}
        onValueChange={(v) => selection.setWarehouseId(v || null)}
        disabled={disabled}
      >
        <SelectTrigger id="sales-warehouse">
          <SelectValue placeholder="Branch default" />
        </SelectTrigger>
        <SelectContent>
          {selection.options.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
              {w.code ? ` (${w.code})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Stock figures and reservations follow this warehouse.
      </p>
    </div>
  );
}
