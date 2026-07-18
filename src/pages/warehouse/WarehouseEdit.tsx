import { useParams, Navigate } from "react-router-dom";
import { useWarehouses } from "@/hooks/useWarehouses";
import { LoadingState, ErrorState } from "@/design-system";
import { WarehouseForm } from "./WarehouseForm";

export default function WarehouseEdit() {
  const { id } = useParams<{ id: string }>();
  const { warehouses, isLoading } = useWarehouses();

  if (!id) return <Navigate to="/warehouse-app/warehouses" replace />;
  if (isLoading) return <LoadingState />;

  const warehouse = warehouses.find((w) => w.id === id);
  if (!warehouse) {
    return (
      <ErrorState
        title="Warehouse not found"
        description="It may have been deleted."
      />
    );
  }

  return <WarehouseForm mode="edit" warehouse={warehouse} />;
}