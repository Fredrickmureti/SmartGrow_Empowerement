import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2 } from "lucide-react";

export interface AdditionalCost {
  id?: string;
  name: string;
  amount: number;
  is_taxable: boolean;
  tax_rate: number;
  tax_amount: number;
  sort_order: number;
}

interface AdditionalCostsSectionProps {
  costs: AdditionalCost[];
  onChange: (costs: AdditionalCost[]) => void;
  formatCurrency?: (amount: number) => string;
}

export function AdditionalCostsSection({
  costs,
  onChange,
  formatCurrency = (amount) => `$${amount.toFixed(2)}`,
}: AdditionalCostsSectionProps) {
  const calculateTaxAmount = (cost: AdditionalCost): number => {
    if (!cost.is_taxable) return 0;
    return cost.amount * (cost.tax_rate / 100);
  };

  const updateCost = (index: number, updates: Partial<AdditionalCost>) => {
    const newCosts = [...costs];
    const updatedCost = { ...newCosts[index], ...updates };
    updatedCost.tax_amount = calculateTaxAmount(updatedCost);
    newCosts[index] = updatedCost;
    onChange(newCosts);
  };

  const addCost = () => {
    onChange([
      ...costs,
      {
        name: "",
        amount: 0,
        is_taxable: false,
        tax_rate: 0,
        tax_amount: 0,
        sort_order: costs.length,
      },
    ]);
  };

  const removeCost = (index: number) => {
    onChange(costs.filter((_, i) => i !== index));
  };

  const totalCosts = costs.reduce((sum, cost) => sum + cost.amount, 0);
  const totalTax = costs.reduce((sum, cost) => sum + cost.tax_amount, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Additional Costs</Label>
        <Button type="button" variant="outline" size="sm" onClick={addCost}>
          <Plus className="mr-1 h-3 w-3" /> Add Cost
        </Button>
      </div>

      {costs.length > 0 && (
        <div className="space-y-2 rounded-lg border p-4">
          {costs.map((cost, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-4">
                <Input
                  placeholder="Cost name (e.g., Shipping)"
                  value={cost.name}
                  onChange={(e) => updateCost(index, { name: e.target.value })}
                  className="h-9"
                />
              </div>
              <div className="col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Amount"
                  value={cost.amount || ""}
                  onChange={(e) =>
                    updateCost(index, { amount: parseFloat(e.target.value) || 0 })
                  }
                  className="h-9"
                />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <Checkbox
                  id={`taxable-${index}`}
                  checked={cost.is_taxable}
                  onCheckedChange={(checked) =>
                    updateCost(index, { is_taxable: checked === true })
                  }
                />
                <Label htmlFor={`taxable-${index}`} className="text-xs">
                  Taxable
                </Label>
              </div>
              <div className="col-span-2">
                {cost.is_taxable && (
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    placeholder="Tax %"
                    value={cost.tax_rate || ""}
                    onChange={(e) =>
                      updateCost(index, { tax_rate: parseFloat(e.target.value) || 0 })
                    }
                    className="h-9"
                  />
                )}
              </div>
              <div className="col-span-1 text-right text-sm text-muted-foreground">
                {formatCurrency(cost.amount + cost.tax_amount)}
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeCost(index)}
                  className="h-8 w-8"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}

          {costs.length > 0 && (
            <div className="flex justify-end border-t pt-2 mt-2">
              <div className="text-sm space-y-1">
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Additional Costs:</span>
                  <span>{formatCurrency(totalCosts)}</span>
                </div>
                {totalTax > 0 && (
                  <div className="flex justify-between gap-8">
                    <span className="text-muted-foreground">Tax on Costs:</span>
                    <span>{formatCurrency(totalTax)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {costs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add shipping, transport, handling fees, or other costs
        </p>
      )}
    </div>
  );
}
