/**
 * Branch-day bound date field.
 *
 * Once a branch is under day control (`branches.day_control_from` reached),
 * an operator no longer types the transaction date: money is recorded into
 * the branch's open operational day, and nothing else. This component is the
 * single UI expression of that rule — the database RPCs and the
 * `enforce_branch_day_lock` trigger remain the authority; this only stops the
 * operator walking into a refusal.
 *
 * Before the activation date the field behaves exactly as it always did.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/hooks/useBranches";
import { useOpenBranchDay, todayIso } from "@/hooks/useBranchDay";

export interface BranchDayGate {
  /** Day control is in force for this branch today. */
  controlActive: boolean;
  /** The date every money entry must carry, when control is active. */
  lockedDate: string | null;
  /** True when control is active but no day is open — recording is refused. */
  blocked: boolean;
  branchName: string | null;
  isLoading: boolean;
}

/** Reads the branch's activation date and its open day. */
export function useBranchDayGate(branchId?: string | null): BranchDayGate {
  const { currentBranch } = useBranches();
  const effectiveBranchId = branchId ?? currentBranch?.id ?? null;

  const control = useQuery({
    queryKey: ["branch-day-control", effectiveBranchId],
    queryFn: async () => {
      if (!effectiveBranchId) return null;
      const { data, error } = await supabase
        .from("branches")
        .select("name,day_control_from")
        .eq("id", effectiveBranchId)
        .maybeSingle();
      if (error) throw error;
      return data as { name: string; day_control_from: string | null } | null;
    },
    enabled: !!effectiveBranchId,
    staleTime: 60_000,
  });

  const from = control.data?.day_control_from ?? null;
  const controlActive = !!from && from <= todayIso();

  const openDay = useOpenBranchDay(controlActive ? effectiveBranchId : null);

  return {
    controlActive,
    lockedDate: openDay.data?.business_date ?? null,
    blocked: controlActive && !openDay.data,
    branchName: control.data?.name ?? null,
    isLoading: control.isLoading || openDay.isLoading,
  };
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Defaults to the active branch. */
  branchId?: string | null;
  id?: string;
  className?: string;
}

/**
 * Renders a plain date input before day control, and the branch's open day
 * (read-only, with the day it will post to spelled out) once control is on.
 */
export function BranchDayDateField({
  label,
  value,
  onChange,
  branchId,
  id,
  className,
}: Props) {
  const gate = useBranchDayGate(branchId);

  // Keep the caller's state on the open day so the submitted payload matches
  // what the operator is being shown.
  useEffect(() => {
    if (gate.controlActive && gate.lockedDate && value !== gate.lockedDate) {
      onChange(gate.lockedDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.controlActive, gate.lockedDate]);

  return (
    <div className={className ?? "space-y-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="date"
        value={gate.controlActive ? (gate.lockedDate ?? "") : value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={gate.controlActive}
        disabled={gate.controlActive && gate.blocked}
      />
      {gate.controlActive && gate.lockedDate && (
        <p className="text-xs text-muted-foreground">
          Posting to {longDate(gate.lockedDate)} — the open day at{" "}
          {gate.branchName ?? "this branch"}.
        </p>
      )}
      {gate.blocked && (
        <p className="text-xs text-destructive">
          No day is open at {gate.branchName ?? "this branch"}. Open the day in
          Lending → Branch day before recording money.
        </p>
      )}
    </div>
  );
}

export default BranchDayDateField;
