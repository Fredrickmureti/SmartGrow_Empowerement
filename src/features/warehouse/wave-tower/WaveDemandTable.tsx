/**
 * Outbound demand rail — what is waiting to be waved, and what is blocked.
 *
 * Rows come from `wms_wave_demand`; eligibility and the block reason are
 * server-assigned. The page never re-derives either.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/design-system";
import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WaveDemandRow } from "./contract";

const BLOCK_LABEL: Record<string, string> = {
  order_locked: "Order locked",
  no_stock: "No stock",
  partial_stock: "Partial stock",
};

interface Props {
  rows: WaveDemandRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

export function WaveDemandTable({ rows, selected, onToggle }: Props) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No outbound demand"
        description="Confirmed sales orders awaiting a wave will show up here."
      />
    );
  }

  return (
    <div className="max-h-[45vh] overflow-auto rounded border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted/50">
          <tr className="text-left">
            <th className="w-8 p-2" />
            <th className="p-2">SO#</th>
            <th className="p-2">Customer</th>
            <th className="p-2">Ship by</th>
            <th className="p-2 text-right">Lines</th>
            <th className="p-2 text-right">Units</th>
            <th className="p-2 text-right">Covered</th>
            <th className="p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.sales_order_id}
              className={cn("border-t hover:bg-muted/20", !r.eligible && "opacity-60")}
            >
              <td className="p-2">
                <Checkbox
                  checked={selected.has(r.sales_order_id)}
                  disabled={!r.eligible}
                  onCheckedChange={() => onToggle(r.sales_order_id)}
                />
              </td>
              <td className="p-2 font-mono">{r.so_number}</td>
              <td className="p-2">{r.customer_name ?? "—"}</td>
              <td className="p-2">{r.expected_date ?? "—"}</td>
              <td className="p-2 text-right tabular-nums">{r.open_lines}</td>
              <td className="p-2 text-right tabular-nums">{Number(r.open_units).toFixed(0)}</td>
              <td className="p-2 text-right tabular-nums">{Number(r.covered_units).toFixed(0)}</td>
              <td className="p-2 text-xs text-muted-foreground">
                {r.block_reason ? (BLOCK_LABEL[r.block_reason] ?? r.block_reason) : "Ready"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
