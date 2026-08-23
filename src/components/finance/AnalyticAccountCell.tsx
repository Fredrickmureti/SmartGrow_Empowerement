/**
 * AnalyticAccountCell — compact analytic (cost centre / project / department)
 * picker for a document line row.
 *
 * The attribution is stored on the document line and copied by the server onto
 * the journal entry line at posting time; the database then materialises the
 * analytic ledger (`journal_entry_line_analytics`) from the GL line. The client
 * never writes analytic amounts, so this control only ever chooses an axis.
 *
 * Only postable accounts are offered — archived and restricted accounts are
 * refused by the database and must not be selectable.
 */
import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";

/** Radix Select forbids an empty string value, so "none" needs a sentinel. */
const NONE = "__none__";

interface AnalyticAccountCellProps {
  value: string | null | undefined;
  onChange: (analyticAccountId: string | null) => void;
  disabled?: boolean;
  /** Restrict to these analytic plan codes (e.g. cost_center, department). */
  planCodes?: string[];
  placeholder?: string;
}

export function AnalyticAccountCell({
  value,
  onChange,
  disabled,
  planCodes,
  placeholder = "Analytic",
}: AnalyticAccountCellProps) {
  const { activeAccounts } = useAnalyticAccounts();

  const options = useMemo(() => {
    if (!planCodes || planCodes.length === 0) return activeAccounts;
    return activeAccounts.filter((a) =>
      a.plan?.code ? planCodes.includes(a.plan.code) : false,
    );
  }, [activeAccounts, planCodes]);

  // Nothing to attribute to — don't show a dead control on every line.
  if (options.length === 0) return null;

  return (
    <Select
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
    >
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No analytic</SelectItem>
        {options.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.code ? `${a.code} — ${a.name}` : a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
