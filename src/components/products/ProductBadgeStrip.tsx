import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getProductBadges,
  PRODUCT_BADGE_META,
} from "@/hooks/inventory/useProductBadges";

interface Props {
  product: any;
  hasPackaging: boolean;
  className?: string;
}

/**
 * Renders the small chip group (Multi-UoM, Lot, Expiry, Service, Non-stock)
 * next to a product name in any listing. Centralised so the rule for which
 * chips appear lives in one place — `useProductBadges.getProductBadges`.
 */
export function ProductBadgeStrip({ product, hasPackaging, className }: Props) {
  const badges = getProductBadges(product, hasPackaging);
  if (badges.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className ?? ""}`}>
      {badges.map((b) => {
        const meta = PRODUCT_BADGE_META[b];
        return (
          <Tooltip key={b}>
            <TooltipTrigger asChild>
              <Badge variant={meta.tone} className="text-[10px] px-1.5 py-0">
                {meta.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{meta.title}</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}