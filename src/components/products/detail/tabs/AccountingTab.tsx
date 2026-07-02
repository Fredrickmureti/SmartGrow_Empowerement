import { useAccounts } from "@/hooks/useAccounts";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import { BookOpen } from "lucide-react";

interface Props {
  data: ProductDetailData;
}

export function AccountingTab({ data }: Props) {
  const { accounts } = useAccounts();
  const p = data.product;
  if (!p) return null;

  const name = (id?: string | null) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : id;
  };

  const rows: Array<[string, string | null]> = [
    ["Sales revenue", name(p.sales_account_id)],
    ["COGS", name(p.cogs_account_id)],
    ["Inventory", name(p.inventory_account_id)],
    ["Purchase", name(p.purchase_account_id)],
  ];

  return (
    <div className="space-y-2 pt-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center gap-3 border-b py-2 text-sm last:border-0">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground flex-1">{label}</span>
          <span className="font-medium text-right">{value ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}