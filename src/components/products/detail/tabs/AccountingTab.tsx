import { useAccounts } from "@/hooks/useAccounts";
import { useDefaultAccounts, type DefaultAccountMappings } from "@/hooks/useDefaultAccounts";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import { Badge } from "@/components/ui/badge";
import { BookOpen } from "lucide-react";

interface Props {
  data: ProductDetailData;
}

export function AccountingTab({ data }: Props) {
  const { accounts } = useAccounts();
  const { accounts: defaults } = useDefaultAccounts();
  const p = data.product;
  if (!p) return null;

  /** Resolve an account id to "code — name"; falls back to nothing when unknown. */
  const describe = (id?: string | null) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : null;
  };

  /** Mirrors the posting ladder: product override → company default. */
  const resolve = (
    override: string | null | undefined,
    defaultKey: keyof DefaultAccountMappings
  ): { text: string; inherited: boolean } => {
    const own = describe(override);
    if (own) return { text: own, inherited: false };
    const fallback = describe(defaults[defaultKey]);
    if (fallback) return { text: fallback, inherited: true };
    return { text: "Not configured", inherited: true };
  };

  const rows: Array<[string, ReturnType<typeof resolve>]> = [
    ["Sales revenue", resolve(p.sales_account_id, "sales_revenue_id")],
    ["COGS", resolve(p.cogs_account_id, "cost_of_goods_sold_id")],
    ["Inventory", resolve(p.inventory_account_id, "inventory_account_id")],
    ["Purchase", resolve(p.purchase_account_id, "operating_expenses_id")],
  ];

  return (
    <div className="space-y-2 pt-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center gap-3 border-b py-2 text-sm last:border-0">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground flex-1">{label}</span>
          <span className={value.inherited ? "text-right text-muted-foreground" : "text-right font-medium"}>
            {value.text}
          </span>
          {value.inherited && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
              Default
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
