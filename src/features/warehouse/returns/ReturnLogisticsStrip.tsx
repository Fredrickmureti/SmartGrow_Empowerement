/**
 * ReturnLogisticsStrip — dock, appointment and trailer context for one return
 * (Returns audit, Phase 7.1).
 *
 * `wms_return_orders` already carries `dock_id`, `appointment_id` and
 * `trailer_visit_id`; without this strip the console asked operators to guess
 * where the parcel physically is. Read-only: the yard/dock subsystem owns
 * those records, Returns only reflects them.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CalendarClock, Container, Warehouse } from "lucide-react";
import type { ReturnOrder } from "./returnsModel";

interface LogisticsContext {
  dockLabel: string | null;
  appointmentLabel: string | null;
  appointmentState: string | null;
  trailerLabel: string | null;
  trailerStatus: string | null;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function useReturnLogistics(order: ReturnOrder | null) {
  const dockId = order?.dock_id ?? null;
  const appointmentId = order?.appointment_id ?? null;
  const trailerVisitId = order?.trailer_visit_id ?? null;

  return useQuery({
    queryKey: ["wms-return-logistics", dockId, appointmentId, trailerVisitId],
    enabled: !!(dockId || appointmentId || trailerVisitId),
    queryFn: async (): Promise<LogisticsContext> => {
      const ctx: LogisticsContext = {
        dockLabel: null,
        appointmentLabel: null,
        appointmentState: null,
        trailerLabel: null,
        trailerStatus: null,
      };

      if (dockId) {
        const { data } = await supabase
          .from("warehouse_docks" as any)
          .select("code, name")
          .eq("id", dockId)
          .maybeSingle();
        const row = data as { code?: string; name?: string } | null;
        if (row) ctx.dockLabel = row.name ? `${row.code} · ${row.name}` : (row.code ?? null);
      }

      if (appointmentId) {
        const { data } = await supabase
          .from("wms_dock_appointments" as any)
          .select("reference, window_start, state, arrived_at")
          .eq("id", appointmentId)
          .maybeSingle();
        const row = data as
          | { reference?: string; window_start?: string; state?: string; arrived_at?: string }
          | null;
        if (row) {
          ctx.appointmentLabel = `${row.reference ?? "Appointment"} · ${fmt(row.window_start)}`;
          ctx.appointmentState = row.state ?? null;
        }
      }

      if (trailerVisitId) {
        const { data } = await supabase
          .from("wms_trailer_visits" as any)
          .select("trailer_ref, driver_name, status, dwell_minutes")
          .eq("id", trailerVisitId)
          .maybeSingle();
        const row = data as
          | { trailer_ref?: string; driver_name?: string; status?: string; dwell_minutes?: number }
          | null;
        if (row) {
          ctx.trailerLabel = [row.trailer_ref, row.driver_name].filter(Boolean).join(" · ") || null;
          ctx.trailerStatus =
            row.dwell_minutes != null
              ? `${row.status ?? "in yard"} · ${Math.round(row.dwell_minutes)}m dwell`
              : (row.status ?? null);
        }
      }

      return ctx;
    },
  });
}

export function ReturnLogisticsStrip({ order }: { order: ReturnOrder }) {
  const { data } = useReturnLogistics(order);

  const cells: Array<{ icon: typeof Warehouse; title: string; value: string; sub: string }> = [
    {
      icon: Warehouse,
      title: "Dock",
      value: data?.dockLabel ?? (order.dock_id ? "Loading…" : "Not assigned"),
      sub: order.dock_id ? "Assigned door" : "Assign from the dock schedule",
    },
    {
      icon: CalendarClock,
      title: "Appointment",
      value: data?.appointmentLabel ?? (order.appointment_id ? "Loading…" : "None booked"),
      sub: data?.appointmentState
        ? data.appointmentState.replace(/_/g, " ")
        : `Expected ${fmt(order.expected_at)}`,
    },
    {
      icon: Container,
      title: "Trailer",
      value: data?.trailerLabel ?? (order.trailer_visit_id ? "Loading…" : "No trailer visit"),
      sub: data?.trailerStatus ?? (order.carrier_id ? "Carrier delivery" : "Walk-in / parcel"),
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {cells.map((c) => (
        <div key={c.title} className="rounded-md border p-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <c.icon className="h-3.5 w-3.5" />
            {c.title}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium" title={c.value}>
            {c.value}
          </div>
          <div className="truncate text-xs capitalize text-muted-foreground">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
