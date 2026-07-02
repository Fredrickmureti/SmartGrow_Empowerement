/**
 * PrinterProfilePaperMismatchAlert
 *
 * Phase 5 of the receipt-width audit. Detects the silent
 * mis-configuration where the operator picks a thermal paper size in POS
 * Settings (e.g. `58mm`) but the active register's bound
 * `printer_profiles.paper_size` says something else (e.g. `80mm`, or
 * `NULL`). When that happens, `generate-document` drops the profile's
 * `columns_override` / `margin_cols` (see migration
 * 20260514094336_*.sql + index.ts:1789-1860), the engine falls back to
 * its built-in font-A defaults, and the printed receipt does NOT honour
 * what the user configured — overflow guaranteed.
 *
 * Surfaces an inline `Alert` directly under the Paper Size buttons in
 * `POSSettings`, with a one-click "Update profile" action that writes
 * the selected paper into `printer_profiles.paper_size` so what the user
 * configured becomes what the engine renders.
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
  /** Active printer profile id from the resolved print policy, or null if none bound. */
  profileId: string | null;
  /** Current paper size selected in POS receipt settings. */
  selectedPaper: string;
}

interface ProfilePaperRow {
  paper_size: ThermalPaper | null;
  label: string | null;
}

export function PrinterProfilePaperMismatchAlert({ profileId, selectedPaper }: Props) {
  const queryClient = useQueryClient();
  const isThermalSelected = THERMAL.has(selectedPaper);

  const { data, isLoading } = useQuery<ProfilePaperRow | null>({
    queryKey: ["printer-profile-paper-size", profileId],
    enabled: !!profileId && isThermalSelected,
    queryFn: async () => {
      if (!profileId) return null;
      const { data, error } = await supabase
        .from("printer_profiles")
        .select("paper_size, label")
        .eq("id", profileId)
        .maybeSingle();
      if (error) throw error;
      return (data as ProfilePaperRow | null) ?? null;
    },
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: async (newPaper: ThermalPaper) => {
      if (!profileId) throw new Error("No printer profile bound to this register.");
      const { error } = await supabase
        .from("printer_profiles")
        .update({ paper_size: newPaper } as never)
        .eq("id", profileId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Printer profile updated", {
        description: `Profile paper width set to ${selectedPaper}. Receipts will now render at the configured columns.`,
      });
      queryClient.invalidateQueries({ queryKey: ["printer-profile-paper-size", profileId] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Update failed";
      toast.error("Could not update printer profile", { description: msg });
    },
  });

  const status = useMemo(() => {
    if (!profileId || !isThermalSelected || isLoading || !data) return "ok" as const;
    if (data.paper_size == null) return "unset" as const;
    if (data.paper_size !== selectedPaper) return "mismatch" as const;
    return "ok" as const;
  }, [profileId, isThermalSelected, isLoading, data, selectedPaper]);

  if (status === "ok") return null;

  const profileLabel = data?.label ?? "this register's printer";

  if (status === "mismatch") {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Printer profile mismatch</AlertTitle>
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
              ? "Updating profile…"
              : `Update profile to ${selectedPaper}`}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // status === 'unset' — profile has no bound paper width yet.
  return (
    <Alert className="mt-2">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Printer profile has no paper width set</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          <strong>{profileLabel}</strong> doesn't declare a paper width.
          Without it, hardware-specific column overrides on this profile will
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
            ? "Updating profile…"
            : `Bind profile to ${selectedPaper}`}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
