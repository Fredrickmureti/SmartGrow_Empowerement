import { Badge } from "@/components/ui/badge";
import { useCurrency } from "@/hooks/useCurrency";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import {
import { productBaseLabelOrUnset } from "@/lib/inventory/uom";
  formatQtyWithPacks,
  type PackForRollup,
} from "@/lib/inventory/formatQty";

interface Props {
  data: ProductDetailData;
  onHand: number;
}

export function ValuationTab({ data, onHand }: Props) {
  const { formatCurrency } = useCurrency();
  const p = data.product;
  if (!p) return null;
  const cost = Number(p.cost_price ?? 0);
  const price = Number((p as any).unit_price ?? 0);

  const baseLabel = productBaseLabelOrUnset(p);
  const packs: PackForRollup[] = (data.packaging ?? []).map((pk: any) => ({
    name: pk.name,
    qty_in_base_uom: Number(pk.qty_in_base_uom),
  }));
  const onHandDisplay = formatQtyWithPacks(onHand, packs, baseLabel);

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center justify-between">
        <Stat label={`Unit cost (per ${baseLabel})`} value={formatCurrency(cost)} inline />
        <Badge variant="outline" className="text-[10px]" title="Average Cost on Receipt (ADR-0002)">
          AVCO
        </Badge>
      </div>
      <Stat label="On-hand" value={onHandDisplay} />
      <Stat label="Total cost value" value={formatCurrency(cost * onHand)} strong />
      <Stat label="Total retail value" value={formatCurrency(price * onHand)} />
      {cost > 0 && (
        <Stat
          label="Potential profit"
          value={formatCurrency((price - cost) * onHand)}
          tone={price >= cost ? "success" : "destructive"}
        />
      )}
      <p className="text-xs text-muted-foreground pt-2">
        Cost is maintained as a running average per base unit, recalculated on
        every receipt. Cost-of-goods is posted to the GL at the moving average
        in force at the time of the outbound movement (ADR-0002, ADR-0016).
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  tone,
  inline,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "success" | "destructive";
  inline?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between py-2 text-sm " +
        (inline ? "" : "border-b last:border-0")
      }
    >
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          (strong ? "font-semibold " : "") +
          (tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}
