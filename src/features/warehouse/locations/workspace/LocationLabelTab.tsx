/**
 * LocationLabelTab — the label lifecycle for one position (ADR 0104
 * addendum). Rasterisation stays server-side; this is geometry + print
 * intent only.
 */
import { useState } from "react";
import { Printer, Barcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section, StatusBadge } from "@/design-system";
import { BinLabelDialog } from "../BinLabelDialog";
import { useLocationMutations } from "../useLocationMutations";
import type { LocationNode } from "../types";

export default function LocationLabelTab({
  node,
  warehouseId,
  branchId,
}: {
  node: LocationNode;
  warehouseId: string | null;
  branchId: string | null;
}) {
  const [printOpen, setPrintOpen] = useState(false);
  const { assignBarcodes } = useLocationMutations(warehouseId);

  return (
    <Section
      title="Label"
      description="An unlabelled position can only be reached by typing — which is how mis-picks start."
    >
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={node.barcode ? "success" : "warning"}>
          {node.barcode ? "Labelled" : "No label yet"}
        </StatusBadge>
        <span className="font-mono text-sm">{node.barcode || node.code}</span>
      </div>

      <div className="flex flex-wrap gap-2 pt-4">
        {!node.barcode && (
          <Button
            variant="outline"
            disabled={assignBarcodes.isPending}
            onClick={() => assignBarcodes.mutate([{ id: node.id, barcode: node.code }])}
          >
            <Barcode className="mr-2 h-4 w-4" /> Make scannable
          </Button>
        )}
        <Button onClick={() => setPrintOpen(true)}>
          <Printer className="mr-2 h-4 w-4" /> Print label
        </Button>
      </div>

      <BinLabelDialog
        open={printOpen}
        onOpenChange={setPrintOpen}
        locations={[node]}
        warehouseId={warehouseId}
        branchId={branchId}
      />
    </Section>
  );
}
