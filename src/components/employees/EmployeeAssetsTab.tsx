/**
 * Employee Assets tab — lists fixed_assets assigned to the employee
 * (`assigned_to_employee_id`). HR can mark an asset returned, which
 * stamps `returned_at` and unblocks the offboarding clearance.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/hooks/useCurrency";
import { Package, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

interface Row {
  id: string;
  asset_number: string;
  name: string;
  serial_number: string | null;
  purchase_price: number;
  status: string;
  assigned_at: string | null;
  returned_at: string | null;
  assignment_notes: string | null;
}

export function EmployeeAssetsTab({
  employeeId,
  canEdit = false,
}: {
  employeeId: string;
  canEdit?: boolean;
}) {
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("fixed_assets")
      .select(
        "id,asset_number,name,serial_number,purchase_price,status,assigned_at,returned_at,assignment_notes",
      )
      .eq("assigned_to_employee_id", employeeId)
      .order("assigned_at", { ascending: false, nullsFirst: false });
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [employeeId]);

  useEffect(() => {
    void fetchAssets();
  }, [fetchAssets]);

  const handleReturn = async (id: string) => {
    setBusy(id);
    const { error } = await supabase
      .from("fixed_assets")
      .update({ returned_at: new Date().toISOString() })
      .eq("id", id);
    setBusy(null);
    if (error) {
      toast.error("Failed to mark returned", { description: error.message });
      return;
    }
    toast.success("Asset marked as returned");
    await fetchAssets();
  };

  const outstandingCount = rows.filter((r) => !r.returned_at).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-4 w-4" /> Assigned Assets
        </CardTitle>
        {!loading && (
          <p className="text-xs text-muted-foreground">
            {outstandingCount} outstanding · {rows.length} total
          </p>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No company assets assigned.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge variant="outline">{r.asset_number}</Badge>
                    {r.returned_at ? (
                      <Badge variant="secondary">Returned</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.serial_number && `SN ${r.serial_number} · `}
                    {r.assigned_at &&
                      `Assigned ${format(new Date(r.assigned_at), "MMM d, yyyy")}`}
                    {r.returned_at &&
                      ` · Returned ${format(new Date(r.returned_at), "MMM d, yyyy")}`}
                  </p>
                  {r.assignment_notes && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {r.assignment_notes}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {formatCurrency(r.purchase_price)}
                  </span>
                  {canEdit && !r.returned_at && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleReturn(r.id)}
                      disabled={busy === r.id}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" /> Mark returned
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
