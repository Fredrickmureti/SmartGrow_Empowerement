/**
 * AssetPeekSheet — routed `?peek=<id>` peek for a Fixed Asset.
 * Replaces the legacy `AssetDetailSheet`. Uses the design-system
 * `PeekScaffold`; the depreciation-history table renders as an
 * `extraSection` so it stays intact.
 */
import { format } from "date-fns";

import { PeekScaffold, type DetailField } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { AssetDepreciationHistory } from "@/components/finance/AssetDepreciationHistory";
import { useCurrency } from "@/hooks/useCurrency";
import { useFixedAssets, type FixedAsset } from "@/hooks/useFixedAssets";

interface Props {
  assetId: string | null;
  onOpenChange: (open: boolean) => void;
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-primary/10 text-primary",
  disposed: "bg-muted text-muted-foreground",
  written_off: "bg-destructive/10 text-destructive",
};

export function AssetPeekSheet({ assetId, onOpenChange }: Props) {
  const { assets } = useFixedAssets();
  const { formatCurrency } = useCurrency();
  const asset = assetId ? assets.find((a) => a.id === assetId) || null : null;
  const open = !!assetId;

  const detailFields: DetailField[] = asset
    ? [
        { label: "Asset number", value: <span className="font-mono">{asset.asset_number}</span> },
        { label: "Category", value: asset.category?.name || "—" },
        {
          label: "Purchase date",
          value: format(new Date(asset.purchase_date), "MMM d, yyyy"),
        },
        {
          label: "Purchase price",
          value: formatCurrency(asset.purchase_price),
        },
        {
          label: "Book value",
          value: formatCurrency(asset.book_value || 0),
        },
        {
          label: "Accumulated depreciation",
          value: formatCurrency(asset.accumulated_depreciation || 0),
        },
        {
          label: "Useful life",
          value: `${asset.useful_life_years || 0} years`,
        },
        {
          label: "Depreciation method",
          value: (
            <span className="capitalize">
              {(asset.depreciation_method || "straight_line").replace("_", " ")}
            </span>
          ),
        },
        { label: "Serial number", value: asset.serial_number || "—" },
        { label: "Location", value: asset.location || "—" },
      ]
    : [];

  return (
    <PeekScaffold
      open={open}
      onOpenChange={onOpenChange}
      title={
        asset ? (
          <span className="flex items-center gap-2">
            {asset.name}
            <Badge className={STATUS_STYLES[asset.status] || STATUS_STYLES.active}>
              {asset.status.replace("_", " ")}
            </Badge>
          </span>
        ) : (
          "Asset"
        )
      }
      description={asset ? `Asset #${asset.asset_number}` : undefined}
      fullPageHref={asset ? `/finance/fixed-assets/${asset.id}/edit` : undefined}
      loading={!!assetId && !asset}
      detailFields={detailFields}
      detailsTitle="Overview"
      extraSections={
        asset && (
          <div>
            <h4 className="mb-2 text-sm font-medium">Depreciation history</h4>
            <AssetDepreciationHistory
              assetId={asset.id}
              assetName={asset.name}
            />
          </div>
        )
      }
    />
  );
}

export default AssetPeekSheet;

// Re-export used by the list page to type its state.
export type { FixedAsset };
