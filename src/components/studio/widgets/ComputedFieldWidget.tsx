import { Input } from "@/components/ui/input";
import { Calculator, AlertCircle } from "lucide-react";
import { EntityFieldConfig } from "@/hooks/useEntityFields";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ComputedFieldWidgetProps {
  field: EntityFieldConfig;
  value: string | null;
}

/**
 * Safe expression evaluator for basic arithmetic + field references.
 * Supports: +, -, *, /, parentheses, and numeric literals.
 * Field references are resolved from entityValues.
 */
function evaluateFormula(
  formula: string,
  entityValues: Record<string, string | null>
): { result: string | null; error: string | null } {
  if (!formula?.trim()) return { result: null, error: "No formula defined" };

  try {
    // Replace field references like {field_key} with their numeric values
    let expression = formula.replace(/\{(\w+)\}/g, (_, fieldKey) => {
      const val = entityValues[fieldKey];
      const num = parseFloat(val || "0");
      return isNaN(num) ? "0" : String(num);
    });

    // Validate: only allow numbers, operators, parentheses, whitespace, decimal points
    if (!/^[\d\s+\-*/().]+$/.test(expression)) {
      return { result: null, error: "Invalid characters in formula" };
    }

    // Prevent empty or dangerous expressions
    if (!expression.trim() || expression.includes("**")) {
      return { result: null, error: "Invalid formula" };
    }

    // Use Function constructor for sandboxed arithmetic (no access to globals)
    const fn = new Function(`"use strict"; return (${expression});`);
    const result = fn();

    if (typeof result !== "number" || !isFinite(result)) {
      return { result: null, error: "Formula produced invalid result" };
    }

    // Format to 2 decimal places if needed
    const formatted = Number.isInteger(result) ? String(result) : result.toFixed(2);
    return { result: formatted, error: null };
  } catch (e) {
    return { result: null, error: "Formula evaluation error" };
  }
}

/**
 * Computed field widget - evaluates formula and displays result.
 * Supports basic arithmetic with field references: {price} * {quantity}
 */
export function ComputedFieldWidget({ field, value }: ComputedFieldWidgetProps) {
  const formula = field.computation_formula;
  const hasFormula = !!formula?.trim();

  // If we have a stored value, display it; otherwise show formula info
  const displayValue = value || "";

  return (
    <div className="flex items-center gap-2">
      <Input
        id={field.field_key}
        value={displayValue}
        disabled
        className="bg-muted/50"
        placeholder={hasFormula ? `Formula: ${formula}` : "No formula configured"}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="shrink-0">
            {hasFormula ? (
              <Calculator className="h-4 w-4 text-muted-foreground" />
            ) : (
              <AlertCircle className="h-4 w-4 text-amber-500" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {hasFormula
            ? `Computed: ${formula}`
            : "No computation formula configured. Set one in Studio > Fields."}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export { evaluateFormula };
