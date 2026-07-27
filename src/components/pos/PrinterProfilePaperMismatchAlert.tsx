/**
 * PrinterProfilePaperMismatchAlert
 *
 * Phase 2b — reads/writes the unified `device_assignments` row. The
 * detected condition is unchanged: cashier picked a thermal paper in POS
 * Settings but the register's bound printer says something else (or
 * nothing). Fixing writes `paper_size` on the device row so the ESC/POS
 * builder honours the operator's choice.
 */
import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type ThermalPaper = "40mm" | "58mm" | "80mm";

const THERMAL: ReadonlySet<string> = new Set(["40mm", "58mm", "80mm"]);

interface Props {
  /** Bound `device_assignments.id` from the resolved print policy. */
  deviceAssignmentId: string | null;
  /** Current paper size selected in POS receipt settings. */
  selectedPaper: string;
}

interface DeviceRow {
  id: string;
  paper_size: ThermalPaper | null;
  display_name: string | null;
}

export function PrinterProfilePaperMismatchAlert({ deviceAssignmentId: profileId, selectedPaper }: Props) {
  const queryClient = useQueryClient();
  const isThermalSelected = THERMAL.has(selectedPaper);

  const { data, isLoading } = useQuery<DeviceRow | null>({
    queryKey: ["device-paper-size", profileId],
    enabled: !!profileId && isThermalSelected,
    queryFn: async () => {
      if (!profileId) return null;
      const { data, error } = await supabase
        .from("device_assignments")
        .select("id, paper_size, display_name")
        .eq("id", profileId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: (data as { id: string }).id,
        paper_size: ((data as { paper_size?: string | null }).paper_size ?? null) as ThermalPaper | null,
        display_name: (data as { display_name?: string | null }).display_name ?? null,
      };
    },
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: async (newPaper: ThermalPaper) => {
      if (!data?.id) throw new Error("No printer bound to this register.");
      const { error } = await supabase
        .from("device_assignments")
        .update({ paper_size: newPaper } as never)
        .eq("id", data.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Printer updated", {
        description: `Paper width set to ${selectedPaper}. Receipts will now render at the configured columns.`,
      });
      queryClient.invalidateQueries({ queryKey: ["device-paper-size", profileId] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Update failed";
      toast.error("Could not update printer", { description: msg });
    },
  });

  const status = useMemo(() => {
    if (!profileId || !isThermalSelected || isLoading || !data) return "ok" as const;
    if (data.paper_size == null) return "unset" as const;
    if (data.paper_size !== selectedPaper) return "mismatch" as const;
    return "ok" as const;
  }, [profileId, isThermalSelected, isLoading, data, selectedPaper]);

  if (status === "ok") return null;

  const profileLabel = data?.display_name ?? "this register's printer";

  if (status === "mismatch") {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Printer paper mismatch</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            <strong>{profileLabel}</strong> is configured for{" "}
            <strong>{data?.paper_size}</strong>. Saving <strong>{selectedPaper}</strong>{" "}
            here will not change how the engine renders — receipts will print
            at <strong>{data?.paper_size}</strong> columns and may overflow.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={updateMutation.isPending}
            onClick={() => updateMutation.mutate(selectedPaper as ThermalPaper)}
          >
            {updateMutation.isPending
              ? "Updating…"
              : `Update printer to ${selectedPaper}`}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="mt-2">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Printer has no paper width set</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          <strong>{profileLabel}</strong> doesn't declare a paper width.
          Without it, hardware-specific column overrides on this printer will
          be dropped on every print to stay safe — your selected{" "}
          <strong>{selectedPaper}</strong> will fall back to engine defaults.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={updateMutation.isPending}
          onClick={() => updateMutation.mutate(selectedPaper as ThermalPaper)}
        >
          {updateMutation.isPending
            ? "Updating…"
            : `Bind printer to ${selectedPaper}`}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
