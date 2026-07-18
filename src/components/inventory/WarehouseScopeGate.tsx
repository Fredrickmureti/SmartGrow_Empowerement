/**
 * WarehouseScopeGate — Stage E.1
 *
 * Parallel to BranchScopeGate but for the warehouse boundary. POS shifts and
 * any stock-moving operation cannot proceed if the active branch has no
 * active warehouse — the previous behavior surfaced a confusing "POS sale
 * failed" error. This gate makes the missing prerequisite explicit and
 * actionable.
 */
import { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Warehouse, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

interface WarehouseScopeGateProps {
  children: ReactNode;
  pageName?: string;
}

export function WarehouseScopeGate({
  children,
  pageName = "this page",
}: WarehouseScopeGateProps) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const { data: warehouses, isLoading } = useQuery({
    queryKey: ["warehouses-scope-gate", currentBusiness?.id, currentBranch?.id],
    queryFn: async () => {
      if (!currentBusiness?.id) return [];
      let q = supabase
        .from("warehouses")
        .select("id, name, branch_id, is_in_transit")
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        // The per-business In-Transit warehouse is a virtual transit
        // location used to model two-leg inter-branch transfers (Odoo
        // stock.location pattern). It cannot host operational stock for
        // POS/Sales/Purchases. A branch whose only "warehouse" is the
        // in-transit one must NOT be allowed past the gate, otherwise
        // every downstream movement will fail attribution.
        .eq("is_in_transit", false);
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!currentBusiness?.id,
  });

  if (isLoading) return <>{children}</>;
  if ((warehouses?.length ?? 0) > 0) return <>{children}</>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Warehouse className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>No warehouse for this branch</CardTitle>
              <CardDescription>
                {pageName} cannot operate without an active warehouse — that's
                where stock physically lives. Create one for{" "}
                <strong>{currentBranch?.name ?? "this branch"}</strong> to
                continue.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/warehouse-app/warehouses">
              <Plus className="h-4 w-4 mr-2" />
              Create warehouse
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
