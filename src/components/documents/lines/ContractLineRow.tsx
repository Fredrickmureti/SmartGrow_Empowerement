/**
 * ContractLineRow — line editor for purchase contracts / blanket agreements.
 *
 * A contract line pre-agrees commercial terms rather than ordering goods: a
 * description, an agreed unit price and ceilings (quantity and/or value) that
 * are enforced when a PO draws down against the contract. There is no tax,
 * no ordered quantity and no line total, so it gets its own row on top of the
 * shared measured `EditableLineItemsGrid`.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

export interface ContractLineShape {
  description?: string | null;
  unit_price?: number | null;
  ceiling_quantity?: number | null;
  ceiling_value?: number | null;
}

export const CONTRACT_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 220 },
  {
    id: "unit_price",
    header: "Unit price",
    priority: 1,
    minWidth: 120,
    numeric: true,
    compactLabel: "Unit price",
  },
  {
    id: "ceiling_quantity",
    header: "Ceiling qty",
    priority: 2,
    minWidth: 120,
    numeric: true,
    compactLabel: "Ceiling qty",
  },
  {
    id: "ceiling_value",
    header: "Ceiling value",
    priority: 2,
    minWidth: 130,
    numeric: true,
    compactLabel: "Ceiling value",
  },
];

interface Props<T extends ContractLineShape> {
  index: number;
  item: T;
  layout: EditableRowLayout;
  disabled?: boolean;
  onPatch: (index: number, patch: Partial<T>) => void;
}

function ContractLineRowInner<T extends ContractLineShape>({
  index,
  item,
  layout,
  disabled,
  onPatch,
}: Props<T>) {
  const numeric = (key: "unit_price" | "ceiling_quantity" | "ceiling_value") => (
    <NumericInput
      value={item[key] ?? null}
      disabled={disabled}
      onValueChange={(v) => onPatch(index, { [key]: v ?? null } as Partial<T>)}
      className="h-8"
    />
  );

  const cell = (columnId: string) => {
    switch (columnId) {
      case "description":
        return (
          <Input
            value={item.description ?? ""}
            placeholder="Description"
            disabled={disabled}
            onChange={(e) => onPatch(index, { description: e.target.value } as Partial<T>)}
            className="h-8"
          />
        );
      case "unit_price":
        return numeric("unit_price");
      case "ceiling_quantity":
        return numeric("ceiling_quantity");
      case "ceiling_value":
        return numeric("ceiling_value");
      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} />;
}

export const ContractLineRow = memo(ContractLineRowInner) as typeof ContractLineRowInner;
