/**
 * useLifecycleEvents — reads `employee_lifecycle_events` scoped to the
 * active org/business, joined against `v_employees_canonical` for the
 * employee display name.
 *
 * Consumed by the Lifecycle sub-app timeline + queue pages.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useHrScope } from "@/hooks/hr/useHrScope";

export type LifecycleEventType =
  | "candidate_created" | "application_submitted" | "offer_extended"
  | "offer_accepted" | "offer_declined" | "hired"
  | "onboarding_started" | "onboarding_completed"
  | "probation_started" | "probation_ended" | "probation_extended"
  | "contract_created" | "contract_activated" | "contract_renewed"
  | "contract_amended" | "contract_expired"
  | "salary_revised" | "position_changed"
  | "department_transferred" | "location_transferred" | "manager_changed"
  | "promoted" | "demoted" | "suspended" | "reinstated"
  | "leave_of_absence_started" | "leave_of_absence_ended"
  | "termination_initiated" | "terminated"
  | "offboarding_started" | "offboarding_completed"
  | "final_settlement_paid" | "archived" | "unarchived" | "custom";

export interface LifecycleEvent {
  id: string;
  employee_id: string;
  event_type: LifecycleEventType;
  occurred_at: string;
  effective_date: string | null;
  actor_label: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  source_table: string | null;
  source_id: string | null;
  /** Denormalized display name resolved client-side from canonical view. */
  employee_name: string | null;
  employee_number: string | null;
}

export interface UseLifecycleEventsOptions {
  eventTypes?: LifecycleEventType[];
  employeeId?: string;
  sinceDays?: number;
  limit?: number;
}

export function useLifecycleEvents(opts: UseLifecycleEventsOptions = {}) {
  const { orgId, businessId, isReady } = useHrScope();
  const { eventTypes, employeeId, sinceDays, limit = 200 } = opts;

  const query = useQuery({
    queryKey: [
      "lifecycle-events",
      orgId,
      businessId,
      eventTypes?.slice().sort().join(",") ?? "all",
      employeeId ?? "all",
      sinceDays ?? "all",
      limit,
    ],
    enabled: isReady && !!orgId,
    staleTime: 30_000,
    queryFn: async (): Promise<LifecycleEvent[]> => {
      let q = supabase
        .from("employee_lifecycle_events")
        .select(
          "id, employee_id, event_type, occurred_at, effective_date, actor_label, summary, payload, source_table, source_id",
        )
        .eq("organization_id", orgId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (businessId) q = q.eq("business_id", businessId);
      if (eventTypes?.length) q = q.in("event_type", eventTypes as any);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (sinceDays && sinceDays > 0) {
        const since = new Date();
        since.setDate(since.getDate() - sinceDays);
        q = q.gte("occurred_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      const events = (data ?? []) as any[];

      // Resolve employee display names via v_employees_canonical.
      const ids = Array.from(new Set(events.map((e) => e.employee_id).filter(Boolean)));
      let nameMap = new Map<string, { name: string; number: string | null }>();
      if (ids.length) {
        const { data: emps } = await supabase
          .from("v_employees_canonical")
          .select("id, first_name, last_name, employee_number")
          .in("id", ids);
        (emps ?? []).forEach((e: any) => {
          nameMap.set(e.id, {
            name: [e.first_name, e.last_name].filter(Boolean).join(" ") || "—",
            number: e.employee_number ?? null,
          });
        });
      }

      return events.map((e) => ({
        ...e,
        employee_name: nameMap.get(e.employee_id)?.name ?? null,
        employee_number: nameMap.get(e.employee_id)?.number ?? null,
      })) as LifecycleEvent[];
    },
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

/** Human-friendly labels for enum values. */
export const LIFECYCLE_EVENT_LABELS: Record<LifecycleEventType, string> = {
  candidate_created: "Candidate created",
  application_submitted: "Application submitted",
  offer_extended: "Offer extended",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  hired: "Hired",
  onboarding_started: "Onboarding started",
  onboarding_completed: "Onboarding completed",
  probation_started: "Probation started",
  probation_ended: "Probation ended",
  probation_extended: "Probation extended",
  contract_created: "Contract created",
  contract_activated: "Contract activated",
  contract_renewed: "Contract renewed",
  contract_amended: "Contract amended",
  contract_expired: "Contract expired",
  salary_revised: "Salary revised",
  position_changed: "Position changed",
  department_transferred: "Department transfer",
  location_transferred: "Location transfer",
  manager_changed: "Manager changed",
  promoted: "Promoted",
  demoted: "Demoted",
  suspended: "Suspended",
  reinstated: "Reinstated",
  leave_of_absence_started: "Leave of absence started",
  leave_of_absence_ended: "Leave of absence ended",
  termination_initiated: "Termination initiated",
  terminated: "Terminated",
  offboarding_started: "Offboarding started",
  offboarding_completed: "Offboarding completed",
  final_settlement_paid: "Final settlement paid",
  archived: "Archived",
  unarchived: "Unarchived",
  custom: "Custom event",
};

/** Colour tint per event family — semantic; not hex. */
export function lifecycleEventTone(type: LifecycleEventType): "default" | "secondary" | "destructive" | "outline" {
  if (["terminated", "termination_initiated", "offboarding_started", "archived", "suspended", "demoted", "offer_declined", "contract_expired"].includes(type)) {
    return "destructive";
  }
  if (["hired", "onboarding_completed", "probation_ended", "promoted", "contract_activated", "contract_renewed", "reinstated", "final_settlement_paid"].includes(type)) {
    return "default";
  }
  return "secondary";
}

export function useLifecycleEventCounts(sinceDays = 30) {
  const { events, isLoading } = useLifecycleEvents({ sinceDays, limit: 1000 });
  const counts = useMemo(() => {
    const map = new Map<LifecycleEventType, number>();
    events.forEach((e) => map.set(e.event_type, (map.get(e.event_type) ?? 0) + 1));
    return map;
  }, [events]);
  return { counts, total: events.length, isLoading };
}
