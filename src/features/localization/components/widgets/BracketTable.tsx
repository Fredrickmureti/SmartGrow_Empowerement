/**
 * BracketTable — spreadsheet-style editor for income-tax / progressive
 * brackets and graduated bands. Replaces the generic stacked-card array
 * editor when `ui_schema` declares `bracket-table` or `BandsWidget`.
 *
 * Item shape (covers both seeded schemas):
 *  - { min, max?, rate }                 (income_tax/progressive)
 *  - { lower?, upper, rate }             (income_tax/graduated)
 *
 * "Upper" supports an "Unlimited" toggle that maps to `null`. Rows are
 * rendered in their stored order so reordering by drag is left for a
 * future round, but ascending-by-lower is asserted on save by the schema
 * validator already.
 */
import { memo, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";

type BandRow = Record<string, any>;

interface Props {
  value: BandRow[];
  onChange: (next: BandRow[]) => void;
  itemsSchema?: any;
}

/** Detect which "lower" / "upper" / "rate" key names this schema uses. */
function inferKeys(itemsSchema: any) {
  const props = itemsSchema?.properties ?? {};
  const lowerKey = "min" in props ? "min" : "lower";
  const upperKey = "max" in props ? "max" : "upper";
  // Some schemas express rate as fraction 0..1, some as percent 0..100.
  const rateProp = props.rate ?? {};
  const isPercent = (rateProp.maximum ?? 100) > 1.001; // 100 → percent UI; 1 → fraction UI
  return { lowerKey, upperKey, isPercent };
}

export const BracketTable = memo(function BracketTable({ value, onChange, itemsSchema }: Props) {
  const { lowerKey, upperKey, isPercent } = useMemo(() => inferKeys(itemsSchema), [itemsSchema]);

  const updateRow = (idx: number, patch: BandRow) => {
    onChange(value.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeRow = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const addRow = () => {
    const lastLower = value.length > 0 ? Number(value[value.length - 1]?.[lowerKey] ?? 0) : 0;
    const lastUpper = value.length > 0 ? value[value.length - 1]?.[upperKey] : null;
    const nextLower = typeof lastUpper === "number" ? lastUpper : lastLower;
    onChange([...value, { [lowerKey]: nextLower, [upperKey]: null, rate: 0 }]);
  };

  return (
    <div className="space-y-2 border rounded-md">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 px-3 pt-2 text-[11px] font-medium text-muted-foreground">
        <div>Lower</div>
        <div>Upper</div>
        <div>Rate {isPercent ? "(%)" : "(0–1)"}</div>
        <div className="w-8" />
      </div>
      <div className="divide-y">
        {value.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            No brackets yet. Add the first band to begin.
          </div>
        )}
        {value.map((row, idx) => {
          const upperVal = row[upperKey];
          const isUnlimited = upperVal === null || upperVal === undefined;
          return (
            <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 px-3 py-2 items-center">
              <NumericInput
                value={typeof row[lowerKey] === "number" ? row[lowerKey] : null}
                onValueChange={(n) => updateRow(idx, { [lowerKey]: n ?? 0 })}
                min={0}
              />
              <div className="flex items-center gap-2">
                <NumericInput
                  disabled={isUnlimited}
                  placeholder={isUnlimited ? "Unlimited" : ""}
                  value={isUnlimited ? null : (upperVal as number)}
                  onValueChange={(n) => updateRow(idx, { [upperKey]: n })}
                  min={0}
                />
                <label className="text-[10px] text-muted-foreground flex items-center gap-1 whitespace-nowrap">
                  <Switch
                    checked={isUnlimited}
                    onCheckedChange={(checked) =>
                      updateRow(idx, { [upperKey]: checked ? null : Math.max(Number(row[lowerKey] ?? 0), 0) })
                    }
                  />
                  ∞
                </label>
              </div>
              <div className="flex items-center gap-1">
                <NumericInput
                  value={typeof row.rate === "number" ? row.rate : null}
                  onValueChange={(n) => updateRow(idx, { rate: n ?? 0 })}
                  min={0}
                  max={isPercent ? 100 : 1}
                  step={isPercent ? "0.1" : "0.01"}
                />
                {isPercent && <span className="text-xs text-muted-foreground">%</span>}
              </div>
              <Button size="icon" variant="ghost" type="button" onClick={() => removeRow(idx)} aria-label="Remove bracket">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="px-3 pb-2">
        <Button variant="outline" size="sm" type="button" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1" />Add bracket
        </Button>
      </div>
    </div>
  );
});
