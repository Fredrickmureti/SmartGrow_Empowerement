/**
 * TierTable — spreadsheet-style editor for statutory_deduction tiers
 * (NSSF-style employer + employee rates per band). Mounted by SchemaForm
 * when `ui_schema` declares `tier-table`.
 *
 * Item shape (covers both seeded variants):
 *  - { name, lower_earnings_limit, upper_earnings_limit?, employee_rate, employer_rate }
 *  - { lower?, upper, employee_rate, employer_rate }
 */
import { memo, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";

type TierRow = Record<string, any>;

interface Props {
  value: TierRow[];
  onChange: (next: TierRow[]) => void;
  itemsSchema?: any;
}

function inferKeys(itemsSchema: any) {
  const props = itemsSchema?.properties ?? {};
  const lowerKey = "lower_earnings_limit" in props ? "lower_earnings_limit" : "lower";
  const upperKey = "upper_earnings_limit" in props ? "upper_earnings_limit" : "upper";
  const hasName = "name" in props;
  const erProp = props.employee_rate ?? {};
  const isPercent = (erProp.maximum ?? 100) > 1.001;
  return { lowerKey, upperKey, hasName, isPercent };
}

export const TierTable = memo(function TierTable({ value, onChange, itemsSchema }: Props) {
  const { lowerKey, upperKey, hasName, isPercent } = useMemo(() => inferKeys(itemsSchema), [itemsSchema]);

  const updateRow = (idx: number, patch: TierRow) =>
    onChange(value.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRow = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const addRow = () => {
    const last = value[value.length - 1];
    const nextLower = last && typeof last[upperKey] === "number" ? last[upperKey] : Number(last?.[lowerKey] ?? 0);
    onChange([
      ...value,
      {
        ...(hasName ? { name: "" } : {}),
        [lowerKey]: nextLower,
        [upperKey]: null,
        employee_rate: 0,
        employer_rate: 0,
      },
    ]);
  };

  const cols = hasName ? "[1.2fr_1fr_1fr_1fr_1fr_auto]" : "[1fr_1fr_1fr_1fr_auto]";
  return (
    <div className="space-y-2 border rounded-md">
      <div className={`grid grid-cols-${cols} gap-2 px-3 pt-2 text-[11px] font-medium text-muted-foreground`}>
        {hasName && <div>Name</div>}
        <div>Lower</div>
        <div>Upper</div>
        <div>Employee {isPercent ? "(%)" : "(0–1)"}</div>
        <div>Employer {isPercent ? "(%)" : "(0–1)"}</div>
        <div className="w-8" />
      </div>
      <div className="divide-y">
        {value.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">No tiers yet.</div>
        )}
        {value.map((row, idx) => {
          const upperVal = row[upperKey];
          const isUnlimited = upperVal === null || upperVal === undefined;
          return (
            <div key={idx} className={`grid grid-cols-${cols} gap-2 px-3 py-2 items-center`}>
              {hasName && (
                <Input value={row.name ?? ""} onChange={(e) => updateRow(idx, { name: e.target.value })} placeholder="Tier I" />
              )}
              <NumericInput
                min={0}
                value={typeof row[lowerKey] === "number" ? row[lowerKey] : null}
                onValueChange={(n) => updateRow(idx, { [lowerKey]: n ?? 0 })}
              />
              <div className="flex items-center gap-2">
                <NumericInput
                  min={0}
                  disabled={isUnlimited}
                  placeholder={isUnlimited ? "Unlimited" : ""}
                  value={isUnlimited ? null : (upperVal as number)}
                  onValueChange={(n) => updateRow(idx, { [upperKey]: n })}
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
                  min={0}
                  max={isPercent ? 100 : 1}
                  step={isPercent ? "0.1" : "0.01"}
                  value={typeof row.employee_rate === "number" ? row.employee_rate : null}
                  onValueChange={(n) => updateRow(idx, { employee_rate: n ?? 0 })}
                />
                {isPercent && <span className="text-xs text-muted-foreground">%</span>}
              </div>
              <div className="flex items-center gap-1">
                <NumericInput
                  min={0}
                  max={isPercent ? 100 : 1}
                  step={isPercent ? "0.1" : "0.01"}
                  value={typeof row.employer_rate === "number" ? row.employer_rate : null}
                  onValueChange={(n) => updateRow(idx, { employer_rate: n ?? 0 })}
                />
                {isPercent && <span className="text-xs text-muted-foreground">%</span>}
              </div>
              <Button size="icon" variant="ghost" type="button" onClick={() => removeRow(idx)} aria-label="Remove tier">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="px-3 pb-2">
        <Button variant="outline" size="sm" type="button" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1" />Add tier
        </Button>
      </div>
    </div>
  );
});
