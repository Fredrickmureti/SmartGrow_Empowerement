/**
 * useReceivingTrailerVisits — Receiving audit, Phase 1 remainder.
 *
 * A receiving session is supervised work against a *trailer*, but the session
 * row only knows its dock appointment. The yard already records the physical
 * visit (`wms_trailer_visits`: carrier, trailer reference, driver, seals,
 * arrival/dock timestamps, dwell) keyed by the same appointment, so we resolve
 * the visit through that link instead of duplicating the columns onto the
 * session.
 *
 * Read-only: the yard board stays the sole writer of trailer visits.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TrailerVisitInfo {
  id: string;
  trailer_ref: string | null;
  driver_name: string | null;
  seal_in: string | null;
  seal_out: string | null;
  status: string | null;
  arrived_at: string | null;
  docked_at: string | null;
  departed_at: string | null;
  dwell_minutes: number | null;
  carrier_name: string | null;
}

interface VisitRow {
  id: string;
  appointment_id: string | null;
  carrier_id: string | null;
  trailer_ref: string | null;
  driver_name: string | null;
  seal_in: string | null;
  seal_out: string | null;
  status: string | null;
  arrived_at: string | null;
  docked_at: string | null;
  departed_at: string | null;
  dwell_minutes: number | null;
}

/**
 * Live dwell in minutes: the stored `dwell_minutes` is only stamped on
 * departure, so an on-dock trailer computes from its arrival timestamp.
 */
export function dwellMinutes(v: TrailerVisitInfo): number | null {
  if (v.dwell_minutes != null) return Math.round(Number(v.dwell_minutes));
  const from = v.arrived_at ?? v.docked_at;
  if (!from) return null;
  return Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000));
}

export function useReceivingTrailerVisits(businessId: string | undefined, appointmentIds: string[]) {
  const ids = useMemo(
    () => Array.from(new Set(appointmentIds.filter(Boolean))).sort(),
    [appointmentIds],
  );

  const { data } = useQuery({
    queryKey: ["wms-receiving-trailer-visits", businessId, ids],
    enabled: !!businessId && ids.length > 0,
    queryFn: async () => {
      const { data: visits, error } = await supabase
        .from("wms_trailer_visits" as any)
        .select(
          "id, appointment_id, carrier_id, trailer_ref, driver_name, seal_in, seal_out, status, arrived_at, docked_at, departed_at, dwell_minutes",
        )
        .eq("business_id", businessId!)
        .in("appointment_id", ids)
        .limit(500);
      if (error) throw error;

      const rows = (visits ?? []) as unknown as VisitRow[];
      const carrierIds = Array.from(new Set(rows.map((r) => r.carrier_id).filter(Boolean) as string[]));
      const carriers = new Map<string, string>();
      if (carrierIds.length > 0) {
        const { data: cs } = await supabase.from("carriers").select("id, name").in("id", carrierIds);
        for (const c of (cs ?? []) as { id: string; name: string | null }[]) {
          if (c.name) carriers.set(c.id, c.name);
        }
      }

      const map = new Map<string, TrailerVisitInfo>();
      for (const r of rows) {
        if (!r.appointment_id) continue;
        // Most recent visit wins when a door is reused within one appointment.
        const existing = map.get(r.appointment_id);
        const candidate: TrailerVisitInfo = {
          id: r.id,
          trailer_ref: r.trailer_ref,
          driver_name: r.driver_name,
          seal_in: r.seal_in,
          seal_out: r.seal_out,
          status: r.status,
          arrived_at: r.arrived_at,
          docked_at: r.docked_at,
          departed_at: r.departed_at,
          dwell_minutes: r.dwell_minutes == null ? null : Number(r.dwell_minutes),
          carrier_name: r.carrier_id ? (carriers.get(r.carrier_id) ?? null) : null,
        };
        if (!existing || (candidate.arrived_at ?? "") > (existing.arrived_at ?? "")) {
          map.set(r.appointment_id, candidate);
        }
      }
      return map;
    },
  });

  return data;
}
