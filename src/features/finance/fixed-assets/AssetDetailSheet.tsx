/**
 * AssetDetailSheet — read-only overview of a Fixed Asset with
 * depreciation history. Mounted on DetailSheet. URL-driven behind
 * `?sheet=detail&id=<asset-uuid>`.
 */
import { format } from "date-fns";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AssetDepreciationHistory } from "@/components/finance/AssetDepreciationHistory";
import { useCurrency } from "@/hooks/useCurrency";
import type { FixedAsset } from "@/hooks/useFixedAssets";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: FixedAsset | null;
}

export function AssetDetailSheet({ open, onOpenChange, asset }: Props) {
  const { formatCurrency } = useCurrency();
  if (!asset) return null;

  const statusStyles: Record<string, string> = {
    active: "bg-primary/10 text-primary",
    disposed: "bg-muted text-muted-foreground",
    written_off: "bg-destructive/10 text-destructive",
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          {asset.name}
          <Badge className={statusStyles[asset.status] || statusStyles.active}>
            {asset.status.replace("_", " ")}
          </Badge>
        </span>
      }
      description={`Asset #${asset.asset_number}`}
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Purchase price</p>
            <p className="text-lg font-bold">
              {formatCurrency(asset.purchase_price)}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Book value</p>
            <p className="text-lg font-bold">
              {formatCurrency(asset.book_value || 0)}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Depreciation</p>
            <p className="text-lg font-bold">
              {formatCurrency(asset.accumulated_depreciation || 0)}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Useful life</p>
            <p className="text-lg font-bold">
              {asset.useful_life_years || 0}y
            </p>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Category</span>
              <span>{asset.category?.name || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Purchase date</span>
              <span>{format(new Date(asset.purchase_date), "MMM d, yyyy")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Serial number</span>
              <span>{asset.serial_number || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Location</span>
              <span>{asset.location || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Depreciation method</span>
              <span className="capitalize">
                {(asset.depreciation_method || "straight_line").replace("_", " ")}
              </span>
            </div>
            {asset.description && (
              <>
                <Separator />
                <p className="text-muted-foreground">{asset.description}</p>
              </>
            )}
          </CardContent>
        </Card>

        <div>
          <h4 className="text-sm font-medium mb-2">Depreciation history</h4>
          <AssetDepreciationHistory
            assetId={asset.id}
            assetName={asset.name}
          />
        </div>
      </div>
    </DetailSheet>
  );
}

export default AssetDetailSheet;
