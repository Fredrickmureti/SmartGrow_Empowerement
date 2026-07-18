/**
 * Warehouse peek sheet — opened from `?peek=<warehouseId>` on the
 * `/warehouse-app/warehouses` list. Composed on `DetailSheet` per the
 * enterprise record-interaction standard (see
 * `docs/design-system/records.md`).
 */
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Warehouse as WarehouseIcon, ExternalLink, MapPin, User, Mail, Phone } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWarehouses } from "@/hooks/useWarehouses";
import { LoadingState } from "@/design-system";

interface WarehousePeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warehouseId: string | null;
}

export function WarehousePeekSheet({ open, onOpenChange, warehouseId }: WarehousePeekSheetProps) {
  const navigate = useNavigate();
  const { warehouses, isLoading } = useWarehouses();
  const warehouse = warehouseId ? warehouses.find((w) => w.id === warehouseId) : null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <WarehouseIcon className="h-5 w-5" />
          {warehouse?.name || "Warehouse"}
        </span>
      }
      description="Warehouse details"
    >
      {isLoading ? (
        <div className="py-8">
          <LoadingState />
        </div>
      ) : warehouse ? (
        <div className="space-y-4 mt-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Code</p>
              <p className="font-semibold">{warehouse.code || "—"}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Status</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge variant={warehouse.is_active ? "default" : "secondary"}>
                  {warehouse.is_active ? "Active" : "Inactive"}
                </Badge>
                {warehouse.is_default && <Badge variant="outline">Default</Badge>}
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" /> Location
            </p>
            <p className="font-medium mt-1">
              {[warehouse.address, warehouse.city, warehouse.country]
                .filter(Boolean)
                .join(", ") || "—"}
            </p>
          </div>

          {(warehouse.manager_name || warehouse.manager_email || warehouse.manager_phone) && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-sm font-semibold">Manager</p>
                {warehouse.manager_name && (
                  <p className="text-sm flex items-center gap-2">
                    <User className="h-3 w-3 text-muted-foreground" /> {warehouse.manager_name}
                  </p>
                )}
                {warehouse.manager_email && (
                  <p className="text-sm flex items-center gap-2">
                    <Mail className="h-3 w-3 text-muted-foreground" /> {warehouse.manager_email}
                  </p>
                )}
                {warehouse.manager_phone && (
                  <p className="text-sm flex items-center gap-2">
                    <Phone className="h-3 w-3 text-muted-foreground" /> {warehouse.manager_phone}
                  </p>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                onOpenChange(false);
                navigate(`/warehouse-app/warehouses/${warehouse.id}`);
              }}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Record
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                onOpenChange(false);
                navigate(`/warehouse-app/warehouses/${warehouse.id}/edit`);
              }}
            >
              Edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <WarehouseIcon className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Warehouse not found</p>
        </div>
      )}
    </DetailSheet>
  );
}

export default WarehousePeekSheet;
